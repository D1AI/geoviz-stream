import os
import asyncio
from typing import Optional, Tuple, Dict
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from aiokafka import AIOKafkaConsumer, TopicPartition
import orjson as json
import time

# setting env vars for runner
BROKERS = os.getenv("KAFKA_BROKERS", "redpanda:9092")
TOPIC = os.getenv("TOPIC", "ships") # kafka topic to listen to
SEND_INTERVAL_MS = int(os.getenv("SEND_INTERVAL_MS", "200")) # how often to send data to client
MAX_PER_TICK     = int(os.getenv("MAX_PER_TICK", "500")) # max records to send per tick
CLIENT_BUFFER_MAX = int(os.getenv("CLIENT_BUFFER_MAX", "5000")) # max records to buffer per client
DEDUPE_TTL_SEC = float(os.getenv("DEDUPE_TTL_SEC", "2.0")) # how long to remember last position per vessel for deduplication
IDLE_PING_SEC = int(os.getenv("IDLE_PING_SEC", "20")) # how often to send pings on idle connections
EMIT_HISTORY_MARKERS = os.getenv("EMIT_HISTORY_MARKERS", "true").lower() != "false" # whether to emit history_start/history_done markers in hybrid mode

app = FastAPI(title="AIS WS")

# extremely simple healthcheck for server health
@app.get("/healthz")
async def healthz():
    return {"ok": True}

# bbox parser to get lat/lon bounds from query param
def parse_bbox(q: str) -> Optional[Tuple[float, float, float, float]]:
    if not q:
        return None
    parts = q.split(",")
    if len(parts) != 4:
        return None
    lat1, lon1, lat2, lon2 = map(float, parts)
    lo_lat, hi_lat = sorted((lat1, lat2))
    lo_lon, hi_lon = sorted((lon1, lon2))
    return (lo_lat, lo_lon, hi_lat, hi_lon)

# check if a point is inside the bbox
def inside_bbox(lat: float, lon: float, bbox) -> bool:
    if not bbox:
        return True
    lo_lat, lo_lon, hi_lat, hi_lon = bbox
    return (lo_lat <= lat <= hi_lat) and (lo_lon <= lon <= hi_lon)

def parse_lookback_min(q: str) -> int:
    # minute to get historical data (0 = live only)
    try:
        n = int(q)
        return max(0, n)
    except Exception:
        return 0

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()

    bbox = parse_bbox(ws.query_params.get("bbox", ""))
    lookback_min = parse_lookback_min(ws.query_params.get("lookback_min", "0"))
    send_interval = SEND_INTERVAL_MS / 1000.0

    consumer = AIOKafkaConsumer(
        bootstrap_servers=BROKERS,
        value_deserializer=lambda b: json.loads(b), # each message should be a JSON
        enable_auto_commit=False,
        auto_offset_reset="latest",
        group_id=None
    )
    await consumer.start()

    q: asyncio.Queue = asyncio.Queue(maxsize=CLIENT_BUFFER_MAX)
    last_sent: Dict[str, Tuple[float, float, float]] = {}

    historical_mode = lookback_min > 0 # true if lookback_min > 0
    end_ts_ms = None
    passed_end_by_partition: Dict[int, bool] = {}
    history_done_sent = False

    try:
        if not historical_mode:
            # just return live data
            consumer.subscribe([TOPIC])
        else:
            parts = consumer.partitions_for_topic(TOPIC)
            if not parts:
                # just live, no partitions info
                consumer.subscribe([TOPIC])
            else:
                tps = [TopicPartition(TOPIC, p) for p in parts]
                consumer.assign(tps)

                now_ms = int(time.time() * 1000)
                start_ts_ms = now_ms - lookback_min * 60 * 1000
                end_ts_ms   = now_ms  # fixed boundary (“now” at connect)

                # Find offsets >= start_ts for each partition
                offsets = await consumer.offsets_for_times({tp: start_ts_ms for tp in tps})

                # Also fetch end offsets for the "start at tail" fallback
                end_offs = await consumer.end_offsets(tps)

                for tp in tps:
                    off_meta = offsets.get(tp) # get message from offset for time
                    if off_meta is not None and getattr(off_meta, "offset", None) is not None:
                        consumer.seek(tp, off_meta.offset)
                        passed_end_by_partition[tp.partition] = False
                    else:
                        # Nothing at/after start_ts → jump to partition tail so we don’t replay older data
                        consumer.seek(tp, end_offs[tp])
                        passed_end_by_partition[tp.partition] = True  # already past boundary

                if EMIT_HISTORY_MARKERS:
                    try:
                        await ws.send_text('{"type":"history_start"}')
                    except Exception:
                        pass

        stop_sender = asyncio.Event()

        async def consume_task():
            nonlocal history_done_sent
            try:
                async for msg in consumer:
                    rec = msg.value
                    lat = rec.get("lat"); lon = rec.get("lon"); vid = rec.get("id")
                    if lat is None or lon is None or not vid:
                        continue
                    if not inside_bbox(lat, lon, bbox): # check if in bbox
                        continue

                    # Boundary tracking per partition (only in hybrid)
                    if historical_mode and end_ts_ms is not None:
                        ts = msg.timestamp or 0
                        if ts > end_ts_ms:
                            passed_end_by_partition[msg.partition] = True
                            if (not history_done_sent) and passed_end_by_partition and all(passed_end_by_partition.values()):
                                history_done_sent = True
                                if EMIT_HISTORY_MARKERS:
                                    try:
                                        await ws.send_text('{"type":"history_done"}')
                                    except Exception:
                                        pass

                    # Dedupe within TTL if position unchanged
                    entry = last_sent.get(vid)
                    now = time.time()
                    if entry:
                        prev_lat, prev_lon, prev_ts = entry
                        if abs(prev_lat - lat) < 1e-6 and abs(prev_lon - lon) < 1e-6 and (now - prev_ts) < DEDUPE_TTL_SEC:
                            continue

                    try:
                        q.put_nowait(rec)
                    except asyncio.QueueFull:
                        pass
            except Exception:
                pass
            finally:
                stop_sender.set()

        async def sender_task():
            try:
                last_ping = time.time()
                while True:
                    await asyncio.sleep(send_interval)

                    sent = 0
                    while sent < MAX_PER_TICK and not q.empty():
                        rec = q.get_nowait()
                        vid = rec.get("id")
                        if vid:
                            last_sent[vid] = (rec.get("lat"), rec.get("lon"), time.time())
                        await ws.send_text(json.dumps(rec).decode("utf-8"))
                        sent += 1

                    # Keepalive ping
                    now = time.time()
                    if now - last_ping >= IDLE_PING_SEC:
                        try:
                            await ws.send_text('{"type":"ping"}')
                        except Exception:
                            break
                        last_ping = now
            except WebSocketDisconnect:
                pass
            except Exception:
                pass

        consumer_coro = asyncio.create_task(consume_task())
        sender_coro = asyncio.create_task(sender_task())
        await asyncio.gather(consumer_coro, sender_coro)

    finally:
        try:
            await consumer.stop()
        except Exception:
            pass
        try:
            await ws.close()
        except Exception:
            pass