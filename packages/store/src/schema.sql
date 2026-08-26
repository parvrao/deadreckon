-- DEADRECKON :: schema
--
-- Design constraints that drove every decision below:
--   1. observation is APPEND-ONLY. No UPDATE, no DELETE except retention.
--      That is what makes "scrub to any moment" possible without anyone
--      having pressed record, and what makes the hash chain meaningful.
--   2. Must survive a 1 GB free-tier Postgres. Hence BRIN over B-tree on
--      the time axis (a BRIN index on 40M append-ordered rows is ~200 KB),
--      real4 over float8 for kinematics, and tiered retention.
--   3. Every read the console performs must hit an index. There is no
--      query in the API that does a sequential scan on observation.

-- ---------------------------------------------------------------- sources

CREATE TABLE IF NOT EXISTS source (
  id        int PRIMARY KEY,
  key       text UNIQUE NOT NULL,
  domain    smallint NOT NULL,
  label     text NOT NULL,
  license   text NOT NULL,
  homepage  text NOT NULL
);

-- ------------------------------------------------------------ provenance
-- One row per upstream HTTP response or WebSocket batch.
-- chain_sha = sha256(prev_chain_sha || payload_sha). Append-only.
-- Publish the head and the whole archive behind it is frozen.

CREATE TABLE IF NOT EXISTS provenance (
  id             bigserial PRIMARY KEY,
  source_id      int NOT NULL REFERENCES source(id),
  url            text NOT NULL,
  fetched_at     timestamptz NOT NULL,
  http_status    int NOT NULL,
  payload_sha    char(64) NOT NULL,
  prev_chain_sha char(64) NOT NULL,
  chain_sha      char(64) NOT NULL,
  parser_version text NOT NULL,
  record_count   int NOT NULL,
  bytes          int NOT NULL
);
CREATE INDEX IF NOT EXISTS provenance_source_id_desc
  ON provenance (source_id, id DESC);
CREATE INDEX IF NOT EXISTS provenance_fetched_brin
  ON provenance USING brin (fetched_at) WITH (pages_per_range = 32);

-- ----------------------------------------------------------- observation
-- The substrate. Everything else is derived and can be rebuilt from here.

CREATE TABLE IF NOT EXISTS observation (
  id            bigserial,
  ts            timestamptz NOT NULL,
  domain        smallint NOT NULL,
  entity_id     text NOT NULL,
  lat           double precision NOT NULL,
  lon           double precision NOT NULL,
  alt_m         real,
  sog_kt        real,
  cog_deg       real,
  flags         int NOT NULL DEFAULT 0,
  conf          smallint NOT NULL DEFAULT 128,
  geohash5      char(5) NOT NULL,
  source_id     int NOT NULL,
  provenance_id bigint,
  props         jsonb
);

-- Append-ordered data. BRIN gives ~99.9% of B-tree's range-scan benefit
-- here for ~0.1% of the size, which is the whole game on a free tier.
CREATE INDEX IF NOT EXISTS observation_ts_brin
  ON observation USING brin (ts) WITH (pages_per_range = 32);
-- "replay this one target's track" -- the Case File's hot query.
CREATE INDEX IF NOT EXISTS observation_entity_ts
  ON observation (entity_id, ts DESC);
-- "what was in this cell at this moment" -- the Scrubber's hot query.
CREATE INDEX IF NOT EXISTS observation_cell_ts
  ON observation (geohash5, ts DESC);

-- --------------------------------------------------------------- entity
-- Denormalized current state. The only table in the system that is UPDATEd.

CREATE TABLE IF NOT EXISTS entity (
  entity_id    text PRIMARY KEY,
  domain       smallint NOT NULL,
  label        text,
  kind         text,
  flag         text,
  first_seen   timestamptz NOT NULL,
  last_seen    timestamptz NOT NULL,
  last_lat     double precision NOT NULL,
  last_lon     double precision NOT NULL,
  last_sog_kt  real,
  last_cog_deg real,
  last_alt_m   real,
  flags        int NOT NULL DEFAULT 0,
  geohash5     char(5) NOT NULL,
  props        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS entity_domain_seen ON entity (domain, last_seen DESC);
CREATE INDEX IF NOT EXISTS entity_cell        ON entity (geohash5);
-- Partial index: finding what has gone dark is the single most frequent
-- scan the engine runs, and it only ever cares about recently-seen targets.
CREATE INDEX IF NOT EXISTS entity_sea_seen
  ON entity (last_seen DESC) WHERE domain = 2;

-- ------------------------------------------------------------ track gap
-- The dark period itself, as a first-class object. Opened when a target
-- stops reporting, closed when it comes back -- and it is the CLOSING
-- that runs the dead-reckon verdict.

CREATE TABLE IF NOT EXISTS track_gap (
  id            bigserial PRIMARY KEY,
  entity_id     text NOT NULL,
  domain        smallint NOT NULL,
  went_dark_at  timestamptz NOT NULL,
  last_lat      double precision NOT NULL,
  last_lon      double precision NOT NULL,
  last_sog_kt   real,
  last_cog_deg  real,
  reacquired_at timestamptz,
  reacq_lat     double precision,
  reacq_lon     double precision,
  verdict       text,
  anomaly_score int,
  evidence      jsonb
);
CREATE INDEX IF NOT EXISTS track_gap_open
  ON track_gap (entity_id) WHERE reacquired_at IS NULL;
CREATE INDEX IF NOT EXISTS track_gap_dark_at ON track_gap (went_dark_at DESC);

-- ------------------------------------------------------------- baseline
-- Rolling normal for a cell at an hour-of-week. Without this, "the
-- airspace emptied" is unmeasurable -- you cannot detect an absence
-- without knowing what presence looked like.

CREATE TABLE IF NOT EXISTS baseline (
  geohash4     char(4) NOT NULL,
  domain       smallint NOT NULL,
  hour_of_week smallint NOT NULL,  -- 0..167
  n            int NOT NULL DEFAULT 0,
  mean_count   real NOT NULL DEFAULT 0,
  m2           real NOT NULL DEFAULT 0,  -- Welford, for online stddev
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (geohash4, domain, hour_of_week)
);

-- ------------------------------------------------------------ detection

CREATE TABLE IF NOT EXISTS detection (
  id             bigserial PRIMARY KEY,
  rule           text NOT NULL,
  severity       int NOT NULL,
  ts_start       timestamptz NOT NULL,
  ts_end         timestamptz,
  lat            double precision NOT NULL,
  lon            double precision NOT NULL,
  geohash5       char(5) NOT NULL,
  entity_ids     text[] NOT NULL DEFAULT '{}',
  title          text NOT NULL,
  summary        text NOT NULL,
  evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance_ids bigint[] NOT NULL DEFAULT '{}',
  state          text NOT NULL DEFAULT 'open',
  hash           char(64) NOT NULL UNIQUE,
  incident_id    bigint,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS detection_ts     ON detection (ts_start DESC);
CREATE INDEX IF NOT EXISTS detection_rule   ON detection (rule, ts_start DESC);
CREATE INDEX IF NOT EXISTS detection_cell   ON detection (geohash5, ts_start DESC);
CREATE INDEX IF NOT EXISTS detection_sev    ON detection (severity DESC, ts_start DESC);
CREATE INDEX IF NOT EXISTS detection_orphan ON detection (ts_start DESC)
  WHERE incident_id IS NULL;

-- ------------------------------------------------------------- incident
-- CONFLUENCE output. Independent detections that agree in space and time.
-- This is the part a human did by hand, over a weekend, after the fact.

CREATE TABLE IF NOT EXISTS incident (
  id            bigserial PRIMARY KEY,
  ts_start      timestamptz NOT NULL,
  ts_end        timestamptz NOT NULL,
  lat           double precision NOT NULL,
  lon           double precision NOT NULL,
  radius_km     real NOT NULL,
  severity      int NOT NULL,
  title         text NOT NULL,
  narrative     text NOT NULL,
  detection_ids bigint[] NOT NULL DEFAULT '{}',
  domains       smallint[] NOT NULL DEFAULT '{}',
  hash          char(64) NOT NULL UNIQUE,
  state         text NOT NULL DEFAULT 'open',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incident_ts  ON incident (ts_start DESC);
CREATE INDEX IF NOT EXISTS incident_sev ON incident (severity DESC, ts_start DESC);

-- ------------------------------------------------------------- watchbox
-- Named areas of interest. Detection thresholds tighten inside them.

CREATE TABLE IF NOT EXISTS watchbox (
  id       serial PRIMARY KEY,
  key      text UNIQUE NOT NULL,
  label    text NOT NULL,
  min_lat  double precision NOT NULL,
  min_lon  double precision NOT NULL,
  max_lat  double precision NOT NULL,
  max_lon  double precision NOT NULL,
  domains  smallint[] NOT NULL DEFAULT '{1,2}',
  dark_threshold_s int NOT NULL DEFAULT 2700,
  active   boolean NOT NULL DEFAULT true
);

-- --------------------------------------------------------- ingest health
-- If a feed dies quietly, every downstream absence becomes a false
-- positive. The console shows this table so "no data" is never mistaken
-- for "nothing is happening".

CREATE TABLE IF NOT EXISTS ingest_health (
  source_id      int PRIMARY KEY REFERENCES source(id),
  last_attempt   timestamptz,
  last_success   timestamptz,
  last_status    int,
  last_error     text,
  consec_errors  int NOT NULL DEFAULT 0,
  records_total  bigint NOT NULL DEFAULT 0,
  fetches_total  bigint NOT NULL DEFAULT 0,
  backoff_until  timestamptz
);
