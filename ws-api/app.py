import os
import asyncio
from typing import Optional, Tuple
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from aiokafka import AIOKafkaConsumer
import orjson as json
import time

# ---------- Config via env ----------
BROKERS = os.getenv("KAFKA_BROKERS", "redpanda:9092")
TOPIC = os.getenv("TOPIC", "ships")

# Throttle: send at most every N ms, and at most M records per tick (per client)
SEND_INTERVAL_MS = int(os.getenv("SEND_INTERVAL_MS", "200"))   # 5 fps default
MAX_PER_TICK     = int(os.getenv("MAX_PER_TICK", "500"))

# Backpressure: per-client buffer size (records). If full, we drop newest to avoid OOM.
CLIENT_BUFFER_MAX = int(os.getenv("CLIENT_BUFFER_MAX", "5000"))

# Dedupe: suppress repeat sends for the same vessel within TTL seconds
DEDUPE_TTL_SEC = float(os.getenv("DEDUPE_TTL_SEC", "2.0"))

# Keepalive ping every N seconds
IDLE_PING_SEC = int(os.getenv("IDLE_PING_SEC", "20"))

app = FastAPI(title="AIS WS")

@app.get("/healthz")
async def healthz():
    return {"ok": True}

# ---------- helpers ----------
def parse_bbox(q: str) -> Optional[Tuple[float, float, float, float]]:
    """
    Parse bbox as 'lat1,lon1,lat2,lon2'. Returns normalized (minLat, minLon, maxLat, maxLon).
    """
    if not q:
        return None
    parts = q.split(",")
    if len(parts) != 4:
        return None
    lat1, lon1, lat2, lon2 = map(float, parts)
    lo_lat, hi_lat = sorted((lat1, lat2))
    lo_lon, hi_lon = sorted((lon1, lon2))
    return (lo_lat, lo_lon, hi_lat, hi_lon)

def inside_bbox(lat: float, lon: float, bbox) -> bool:
    if not bbox:
        return True
    lo_lat, lo_lon, hi_lat, hi_lon = bbox
    return (lo_lat <= lat <= hi_lat) and (lo_lon <= lon <= hi_lon)

# ---------- websocket ----------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    # Accept first, then read query params
    await ws.accept()
    bbox = parse_bbox(ws.query_params.get("bbox", ""))  # lat1,lon1,lat2,lon2
    send_interval = SEND_INTERVAL_MS / 1000.0

    # Independent consumer per connection = simple isolation
    consumer = AIOKafkaConsumer(
        TOPIC,
        bootstrap_servers=BROKERS,
        value_deserializer=lambda b: json.loads(b),
        enable_auto_commit=True,
        auto_offset_reset="latest",
        group_id=None
    )
    await consumer.start()

    # Per-connection buffer (bounded)
    q: asyncio.Queue = asyncio.Queue(maxsize=CLIENT_BUFFER_MAX)

    # Dedupe cache: id -> (last_lat, last_lon, last_sent_ts)
    last_sent = {}

    async def consume_task():
        try:
            async for msg in consumer:
                rec = msg.value  # {"id","lat","lon",...}
                # Basic schema guard
                lat = rec.get("lat")
                lon = rec.get("lon")
                vid = rec.get("id")
                if lat is None or lon is None or not vid:
                    continue
                if not inside_bbox(lat, lon, bbox):
                    continue

                # Dedupe within TTL if position hasn't changed
                entry = last_sent.get(vid)
                now = time.time()
                if entry:
                    prev_lat, prev_lon, prev_ts = entry
                    if abs(prev_lat - lat) < 1e-6 and abs(prev_lon - lon) < 1e-6 and (now - prev_ts) < DEDUPE_TTL_SEC:
                        continue

                # Offer to queue; if full, drop newest (logically best for live feeds)
                try:
                    q.put_nowait(rec)
                except asyncio.QueueFull:
                    # Drop newest; keep system responsive
                    pass
        except Exception as e:
            # Let sender loop notice closure via ws exceptions; this task exits silently
            # (You can print/log if you want, but keeping it quiet avoids stdout noise.)
            _ = e
        finally:
            await consumer.stop()

    async def sender_task():
        try:
            last_ping = time.time()
            while True:
                # Throttle tick
                await asyncio.sleep(send_interval)

                sent = 0
                # Drain up to MAX_PER_TICK; send one-by-one to keep client code unchanged
                while sent < MAX_PER_TICK and not q.empty():
                    rec = q.get_nowait()
                    vid = rec.get("id")
                    if vid:
                        last_sent[vid] = (rec.get("lat"), rec.get("lon"), time.time())
                    await ws.send_text(json.dumps(rec).decode("utf-8"))
                    sent += 1

                # Keepalive ping (FastAPI/Starlette handles ping/pong internally;
                # here we just send a comment-ish frame as text to keep intermediaries alive)
                now = time.time()
                if now - last_ping >= IDLE_PING_SEC:
                    try:
                        await ws.send_text('{"type":"ping"}')
                    except Exception:
                        # client likely gone; let outer finally close
                        break
                    last_ping = now
        except WebSocketDisconnect:
            pass
        except Exception:
            # Swallow; connection will close in finally
            pass
        finally:
            # Nothing special; consumer task will also be canceled on exit
            return

    consumer_coro = asyncio.create_task(consume_task())
    sender_coro = asyncio.create_task(sender_task())

    try:
        await asyncio.gather(consumer_coro, sender_coro)
    finally:
        consumer_coro.cancel()
        sender_coro.cancel()
        try:
            await consumer.stop()
        except Exception:
            pass
        await ws.close()