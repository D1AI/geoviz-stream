import os, asyncio, json, time, logging
import orjson
import websockets
from websockets.exceptions import ConnectionClosed
from aiokafka import AIOKafkaProducer
from aiokafka.errors import KafkaConnectionError

# set up logger
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("ingestor")

BROKERS = os.getenv("KAFKA_BROKERS", "redpanda:9092")
TOPIC = os.getenv("TOPIC", "ships")
API_KEY = os.getenv("AISSTREAM_API_KEY", "")
BBOX_JSON = os.getenv("BBOX_JSON", '[[[48.5, -5.5], [51.5, 2.5]]]')
FILTER_MESSAGE_TYPES = os.getenv("FILTER_MESSAGE_TYPES", "PositionReport")
RECONNECT_SECONDS = float(os.getenv("RECONNECT_SECONDS", "3"))
DEBUG_EVERY = int(os.getenv("DEBUG_EVERY", "200"))
URL = "wss://stream.aisstream.io/v0/stream"

def pack(msg: dict) -> bytes:
    return orjson.dumps(msg)

def build_subscribe() -> str:
    payload = {
        "APIKey": API_KEY,
        "BoundingBoxes": json.loads(BBOX_JSON),
    }
    if FILTER_MESSAGE_TYPES:
        payload["FilterMessageTypes"] = [t.strip() for t in FILTER_MESSAGE_TYPES.split(",") if t.strip()]
    return json.dumps(payload)

def normalize_position(evt: dict):
    pr = evt.get("Message", {}).get("PositionReport", {})
    lat, lon = pr.get("Latitude"), pr.get("Longitude")
    if lat is None or lon is None:
        return None
    return {
        "t": pr.get("TimeStamp", int(time.time())),
        "id": str(pr.get("UserID") or ""),
        "lat": lat,
        "lon": lon,
        "sog": pr.get("Sog"),
        "cog": pr.get("Cog"),
        "hdg": pr.get("TrueHeading"),
        "mt": "PR"
    }

async def start_producer_with_retry() -> AIOKafkaProducer:
    backoff = 1
    while True:
        try:
            producer = AIOKafkaProducer(
                bootstrap_servers=BROKERS,
                linger_ms=50,
                value_serializer=pack,
                client_id="ais-ingestor"
            )
            await producer.start()
            log.info(f"Connected to Kafka at %s", BROKERS)
            return producer
        except KafkaConnectionError as e:
            log.warning("Broker not ready (%s); retrying in %ss", e, backoff)
        except Exception as e:
            log.error("Unexpected error starting producer: %s; retrying in %ss", e, backoff)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 10)

async def run_once(producer: AIOKafkaProducer):
    log.info("Connecting WebSocket → %s", URL)
    async with websockets.connect(URL, max_size=2**22) as ws:
        sub = build_subscribe()
        log.info("Sending AIS subscription: %s", sub)
        await ws.send(sub)

        msg_count = 0
        last_log = time.time()
        while True:
            raw = await ws.recv()
            try:
                evt = json.loads(raw)
            except Exception:
                continue

            if isinstance(evt, dict) and "error" in evt:
                log.error("AIS error frame: %s", evt["error"])
                await asyncio.sleep(1)
                continue

            if evt.get("MessageType") == "PositionReport":
                rec = normalize_position(evt)
                if rec:
                    await producer.send_and_wait(TOPIC, rec, key=rec["id"].encode("utf-8"))
                    msg_count += 1
                    if msg_count % DEBUG_EVERY == 0:
                        now = time.time()
                        rate = DEBUG_EVERY / max(0.001, (now - last_log))
                        last_log = now
                        log.info("Produced %d messages total (≈%.1f/s)", msg_count, rate)
            else:
                if msg_count < 5:
                    log.info("Non-PR message type received: %s", evt.get("MessageType"))

async def main():
    log.info("Starting ingestor… env check: BROKERS=%s, TOPIC=%s", BROKERS, TOPIC)
    if not API_KEY:
        log.error("AISSTREAM_API_KEY is missing"); raise SystemExit(1)
    try:
        log.info("Using BBOX_JSON=%s", BBOX_JSON)
        json.loads(BBOX_JSON)  # will raise if malformed
    except Exception as e:
        log.error("Invalid BBOX_JSON: %s", e); raise

    producer = await start_producer_with_retry()
    try:
        while True:
            try:
                await run_once(producer)
            except (ConnectionClosed, websockets.InvalidStatusCode) as e:
                log.warning("WS closed: %s; reconnecting in %ss", e, RECONNECT_SECONDS)
                await asyncio.sleep(RECONNECT_SECONDS)
            except Exception as e:
                log.error("Loop error: %s; reconnecting in %ss", e, RECONNECT_SECONDS)
                await asyncio.sleep(RECONNECT_SECONDS)
    finally:
        await producer.stop()

if __name__ == "__main__":
    asyncio.run(main())