import os
import time
from typing import Optional, Tuple, Dict

from fastapi import FastAPI, WebSocket
from aiokafka import AIOKafkaConsumer, TopicPartition
import orjson as json


BROKERS = os.getenv("KAFKA_BROKERS", "redpanda:9092")
TOPIC = os.getenv("TOPIC", "ships")

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

def parse_lookback_min(q: Optional[str]) -> Optional[int]:
    if q is None:
        return None
    try:
        n = int(q)
    except (TypeError, ValueError):
        return None
    return max(0, n)

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()

    bbox_param = ws.query_params.get("bbox")
    lookback_param = ws.query_params.get("lookback_min")

    bbox = parse_bbox(bbox_param) if bbox_param else None
    lookback_min = parse_lookback_min(lookback_param)

    if bbox is None:
        await ws.send_text('{"error":"query param bbox must be lat1,lon1,lat2,lon2"}')
        await ws.close(code=4400)
        return

    if lookback_min is None:
        await ws.send_text('{"error":"query param lookback_min must be an integer"}')
        await ws.close(code=4401)
        return

    consumer = AIOKafkaConsumer(
        bootstrap_servers=BROKERS,
        value_deserializer=lambda b: json.loads(b),
        enable_auto_commit=False,
        auto_offset_reset="latest",
        group_id=None,
    )

    history_check: Optional[Dict[int, bool]] = None
    history_cutoff_ms: Optional[int] = None

    await consumer.start()

    try:
        if lookback_min == 0:
            consumer.subscribe([TOPIC])
        else:
            parts = consumer.partitions_for_topic(TOPIC) or set()
            if not parts:
                consumer.subscribe([TOPIC])
                history_sent = True
            else:
                tps = [TopicPartition(TOPIC, p) for p in parts]
                consumer.assign(tps)

                now_ms = int(time.time() * 1000)
                history_cutoff_ms = now_ms
                start_ts_ms = now_ms - lookback_min * 60 * 1000

                offsets = await consumer.offsets_for_times({tp: start_ts_ms for tp in tps})
                end_offsets = await consumer.end_offsets(tps)

                history_check = {tp.partition: False for tp in tps}

                for tp in tps:
                    offset_meta = offsets.get(tp)
                    if offset_meta is not None and getattr(offset_meta, "offset", None) is not None:
                        consumer.seek(tp, offset_meta.offset)
                    else:
                        consumer.seek(tp, end_offsets[tp])
                        history_check[tp.partition] = True

        history_sent = lookback_min == 0 or history_check is None

        async for msg in consumer:
            rec = msg.value
            lat = rec.get("lat")
            lon = rec.get("lon")

            if lat is None or lon is None:
                continue

            if not inside_bbox(lat, lon, bbox):
                continue

            if history_check is not None and history_cutoff_ms is not None and not history_sent:
                message_ts = msg.timestamp or 0
                if message_ts > history_cutoff_ms:
                    history_check[msg.partition] = True
                    if all(history_check.values()):
                        history_sent = True
                        await ws.send_text('{"type":"history_complete"}')

            try:
                await ws.send_text(json.dumps(rec).decode("utf-8"))
            except Exception:
                break
    finally:
        try:
            await consumer.stop()
        except Exception:
            pass
        try:
            await ws.close()
        except Exception:
            pass
        