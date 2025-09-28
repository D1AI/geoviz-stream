import asyncio
import os
import json
import ujson
from aiokafka import AIOKafkaConsumer
import asyncpg
from datetime import datetime, timezone

KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "redpanda:9092")
TOPIC = os.getenv("TOPIC", "ships")
GROUP_ID = os.getenv("GROUP_ID", "ships-archiver")

PG_DSN = "postgres://{user}:{pw}@{host}:{port}/{db}".format(
    user=os.getenv("PGUSER", "ships"),
    pw=os.getenv("PGPASSWORD", "ships"),
    host=os.getenv("PGHOST", "timescaledb"),
    port=os.getenv("PGPORT", "5432"),
    db=os.getenv("PGDATABASE", "ships"),
)

BATCH_MAX_ROWS = int(os.getenv("BATCH_MAX_ROWS", "2000"))
FLUSH_SECONDS = float(os.getenv("FLUSH_SECONDS", "2"))

INSERT_SQL = """
INSERT INTO ship_positions (ts, mmsi, lat, lon, sog, cog, hdg, mt, raw)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
ON CONFLICT (mmsi, ts, mt) DO NOTHING
"""

def _to_dt_from_epoch(value):
    if isinstance(value, (int, float)):
        if value > 10**12:
            return datetime.fromtimestamp(value / 1000.0, tz=timezone.utc)
        return datetime.fromtimestamp(value, tz=timezone.utc)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            return datetime.now(timezone.utc)
    return datetime.now(timezone.utc)

def parse_msg(value_bytes):
    # Example: {"t":1759037077,"id":"215548000","lat":51.833685,"lon":4.0367466,"sog":11.1,"cog":10.6,"hdg":11,"mt":"PR"}
    try:
        d = ujson.loads(value_bytes)
    except Exception:
        d = json.loads(value_bytes)

    ts = _to_dt_from_epoch(d.get("t"))
    id_raw = d.get("id")
    if id_raw is None:
        return None
    try:
        mmsi = int(id_raw)
    except Exception:
        return None

    lat = d.get("lat")
    lon = d.get("lon")
    if lat is None or lon is None:
        return None

    sog = d.get("sog")
    cog = d.get("cog")
    hdg = d.get("hdg")
    mt  = d.get("mt")

    # NOTE: raw must be a string for $9::jsonb
    raw_json = ujson.dumps(d)

    return (
        ts,
        mmsi,
        float(lat),
        float(lon),
        None if sog is None else float(sog),
        None if cog is None else float(cog),
        None if hdg is None else float(hdg),
        None if mt  is None else str(mt),
        raw_json,
    )

async def run():
    consumer = AIOKafkaConsumer(
        TOPIC,
        bootstrap_servers=KAFKA_BROKERS,
        group_id=GROUP_ID,
        enable_auto_commit=False,
        auto_offset_reset="latest",
        max_partition_fetch_bytes=4 * 1024 * 1024,
        fetch_max_wait_ms=500,
    )

    pool = await asyncpg.create_pool(dsn=PG_DSN, min_size=1, max_size=4)

    await consumer.start()
    print("[archiver] consuming", TOPIC)
    try:
        buffer = []
        last_flush = asyncio.get_event_loop().time()

        async for msg in consumer:
            rec = parse_msg(msg.value)
            if rec is not None:
                buffer.append(rec)

            now = asyncio.get_event_loop().time()
            if len(buffer) >= BATCH_MAX_ROWS or (now - last_flush) >= FLUSH_SECONDS:
                if buffer:
                    try:
                        async with pool.acquire() as conn:
                            async with conn.transaction():
                                await conn.executemany(INSERT_SQL, buffer)
                        await consumer.commit()
                        print(f"[archiver] flushed {len(buffer)} rows")
                        buffer.clear()
                    except Exception as e:
                        print("[archiver] DB flush error:", repr(e))
                last_flush = now
    finally:
        if buffer:
            try:
                async with pool.acquire() as conn:
                    async with conn.transaction():
                        await conn.executemany(INSERT_SQL, buffer)
                await consumer.commit()
                print(f"[archiver] final flush {len(buffer)} rows")
            except Exception as e:
                print("[archiver] final flush error:", repr(e))
        await consumer.stop()
        await pool.close()

if __name__ == "__main__":
    asyncio.run(run())