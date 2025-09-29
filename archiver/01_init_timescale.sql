CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS postgis;

-- Minimal schema for AIS-like "PositionReport".
CREATE TABLE IF NOT EXISTS ship_positions (
  ts   TIMESTAMPTZ       NOT NULL,
  mmsi BIGINT            NOT NULL,
  lat  DOUBLE PRECISION  NOT NULL,
  lon  DOUBLE PRECISION  NOT NULL,
  geom geometry(Point, 4326) NOT NULL,
  sog  DOUBLE PRECISION,
  cog  DOUBLE PRECISION,
  hdg  DOUBLE PRECISION,
  mt   TEXT,
  raw  JSONB,
  PRIMARY KEY (mmsi, ts, mt)
);

-- Create hypertable; chunk by 1 day so compression/retention works well.
SELECT create_hypertable('ship_positions', 'ts', if_not_exists => TRUE);

-- Indexes for common queries:
-- Fast time-range scans:
CREATE INDEX IF NOT EXISTS ship_positions_ts_idx ON ship_positions (ts DESC);
-- Filter by vessel + time:
CREATE INDEX IF NOT EXISTS ship_positions_mmsi_ts_idx ON ship_positions (mmsi, ts DESC);
-- Spatial searches by bounding box or proximity:
CREATE INDEX IF NOT EXISTS ship_positions_geom_idx ON ship_positions USING GIST (geom);

-- Enable columnar compression on older chunks:
ALTER TABLE ship_positions SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'mmsi'
);

-- Compress after 7 days:
SELECT add_compression_policy('ship_positions', INTERVAL '7 days');

-- Drop data older than 30 days:
SELECT add_retention_policy('ship_positions', INTERVAL '30 days');
