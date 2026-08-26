# DEADRECKON

**Always-on open-source spatial intelligence. Nobody has to press record.**

Live OSINT maps show you what is out there. This one tells you when something
just changed, while you were asleep, and hands you the evidence chain.

```
                    .-'''-.        <- rMax: max speed x elapsed
                 .-'       `-.
                /   ,-----.   \
               |   /       \   |   <- rMin: minimum plausible transit
               |   |   X   |   |      X = last fix before it went dark
                \   `-----'   /
                 `-.       .-'
                    `-...-'
                 |<-- reachable set -->|

     If it reappears outside this envelope, something happened in the dark.
```

---

## What this is

Three things, welded together, that most live-map projects treat as separate
problems or skip entirely.

### 1. Detection, not decoration

A viewer renders what is present. DEADRECKON fires on what is **absent**, what
is **inconsistent**, and what is **out of family** — with no human watching.

| Rule | What it catches |
|---|---|
| `DARK_VESSEL` | AIS goes quiet, then returns outside its dead-reckoned envelope |
| `SPOOF_DISCONTINUITY` | Reacquisition implies a speed above the class ceiling |
| `AIRSPACE_VOID` | Aircraft count collapses vs this cell's own hour-of-week baseline |
| `GNSS_BLOOM` | Cluster of aircraft reporting degraded navigation integrity |
| `SQUAWK_EMERGENCY` | 7500 / 7600 / 7700 |
| `RENDEZVOUS` | Two hulls <500 m apart, both <1.2 kt, away from a berth |
| `LOITER` | Long path, no progress — the ISR racetrack signature |
| `THERMAL_ANOMALY` | VIIRS 375 m hotspot above 40 MW fire radiative power |
| `SEISMIC_SHALLOW` | M≥3.2 at ≤6 km depth — the profile of a surface release |
| **`CONFLUENCE`** | **Two or more of the above agreeing in space and time, across different sensing modalities** |

`CONFLUENCE` is the one that matters. Fusing six layers into a timeline is
traditionally a human with six browser tabs and a weekend. Here it is a rule
that runs every thirty seconds and requires corroboration from **independent
modalities** before it escalates — which is the only cheap defence against a
single bad feed inventing a war.

### 2. Time, by default

There is no record button anywhere in this application. The ingest worker never
stops writing, so when something happens you drag left. The hour *before*
anyone was paying attention is already in the archive.

Retention is tiered: full fidelity for 48 h, thinned to one fix per entity per
5 minutes out to 30 days. A dark-vessel verdict only needs the fix either side
of the gap, so the thinning costs nothing analytically and buys an order of
magnitude of history on the same disk.

### 3. Provenance, in the box

Every observation traces to a specific HTTP response fetched at a specific
instant, hashed and chained:

```
chain[n] = sha256( chain[n-1] || sha256(payload[n]) )
```

Publish the head hash and every prior record is frozen. Any retroactive edit
breaks every link after it. Verify it yourself at `/api/provenance/verify` —
an integrity claim nobody can check is decoration.

Every detection exports an **evidence bundle**: the finding, every provenance
record, the method, the target tracks, a canonical hash of the bundle, and an
explicit list of *what would have to be true for this to be wrong*. A bundle
that only argues for its own conclusion is advocacy.

---

## The architecture is the product

```
  upstream OSINT feeds
        |
        |  ONE poll loop. ONE replica. Never scaled horizontally.
        v
  [ ingest worker ] ---- provenance: sha256 chain per source
        |
        v
  [ postgres ] --------- append-only archive, BRIN on the time axis
        |
        v
  [ api + hub ] -------- stateless, read-only, scale to N replicas
        |                ONE query per tick shared by EVERY socket
        |                geohash-addressed fan-out, binary deltas
        v
  [ browsers ] --------- 28 bytes per contact per frame
```

The obvious way to build a live OSINT map is to let the browser call the feeds,
or proxy per request. Cost is then **O(viewers × sources)**, and the upstream
rate limit becomes a function of your popularity. The moment such a project
goes viral is the moment it gets banned from its own data.

Here the write path and the read path never touch:

- **Upstream cost is constant in viewers.** Ten thousand concurrent viewers
  generate exactly as many upstream requests as zero viewers: none.
- **Database cost is constant in viewers.** One snapshot query per tick,
  bucketed by geohash cell once, read by every socket.
- **Only the per-socket diff scales**, and it scales with viewport size rather
  than world size.

### The wire

Positions travel as fixed 28-byte binary records; entity IDs are interned to a
`u32` on first sight. Control messages stay JSON, because optimizing a
handshake is a waste of an afternoon.

| | bytes/contact | 12,000 contacts |
|---|---|---|
| JSON | ~118 | 1,383 KB |
| DRWP/1 | 28 | 328 KB |

Plus a delta gate: an unchanged fix is not resent for 20 seconds, so a
stationary vessel costs nothing at all after the first frame.

### Why 2D, not a photorealistic globe

Deliberate, not a limitation.

- Photoreal 3D tiles are the largest cost line in a project like this, billed
  per session.
- A globe hides half the planet at all times — exactly wrong for a system whose
  job is to notice things you were not looking at.
- This runs at 60 fps on a phone and on a locked-down work laptop.

---

## Quickstart

```bash
git clone <your-repo-url> deadreckon && cd deadreckon
npm ci

cp .env.example .env      # add DATABASE_URL, and AISSTREAM_API_KEY for sea
export $(grep -v '^#' .env | xargs)

npm run build             # all workspaces
npm run migrate           # idempotent; safe to re-run

npm run start:ingest &    # the only writer
npm run start:server &    # api + websocket hub on :8080
npm run dev:web           # console on :5173, proxied to :8080
```

`npm test` runs 28 unit tests over the geodesy, the dead-reckoning verdicts,
the binary codec, the hash chain, and CONFLUENCE clustering. No database, no
network, under a second.

### Free API keys

| Key | Source | Without it |
|---|---|---|
| `AISSTREAM_API_KEY` | [aisstream.io](https://aisstream.io) | **The sea domain is disabled.** Dark-vessel detection is the flagship rule — get this one. |
| `FIRMS_MAP_KEY` | [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/api/) | No thermal layer |
| `OPENSKY_CLIENT_ID` / `_SECRET` | [OpenSky](https://opensky-network.org) | Falls back to adsb.lol, which needs no key |

Air, orbital, seismic and media all work with no credentials at all.

---

## Deploy to Render

The repo ships a Blueprint. From a fresh push:

1. Render Dashboard → **New** → **Blueprint** → pick the repo → **Apply**.
2. Set `AISSTREAM_API_KEY` (and optionally `FIRMS_MAP_KEY`) on
   `deadreckon-ingest`.
3. Set `VITE_API_URL` and `VITE_WS_URL` on `deadreckon-web` to the
   `deadreckon-api` URL, then redeploy the static site.
4. Set `CORS_ORIGIN` on `deadreckon-api` to the static site URL.

`scripts/bootstrap.sh` does step 0 — creates the GitHub repo, commits, pushes,
and prints the exact follow-up.

Two things to know about the free tier:

- **Render free Postgres expires after 30 days.** For anything permanent, point
  `DATABASE_URL` at Neon or Supabase on both services and delete the
  `databases:` block from `render.yaml`.
- **Background workers are not on Render's free tier.** `deadreckon-ingest` is
  set to `starter`. Without a running worker the archive stays empty and the
  console will correctly tell you so.

Alternative topology, all free tiers: Vercel (web) + Fly.io (api + worker,
because they need long-lived sockets) + Neon (Postgres). Same env vars.

---

## API

| | |
|---|---|
| `GET /api/health` | service, db, hub counters |
| `GET /api/stats` | archive size, ingest health, wire ratio |
| `GET /api/sources` | every feed, its licence, its live health |
| `GET /api/detections` | `?since&minSeverity&rule&limit` |
| `GET /api/detections/:id` | the Case File: provenance, tracks, reachable-set polygon |
| `GET /api/detections/:id/evidence` | downloadable evidence bundle |
| `GET /api/incidents` · `/:id` | CONFLUENCE output and its members |
| `GET /api/replay?at=&minLat=…` | reconstruct any past moment |
| `GET /api/track/:entityId` | one target's history |
| `GET /api/provenance/verify` | recompute the hash chains |
| `WS /stream` | binary position deltas, geohash-scoped |

---

## What this gives up

Stated plainly, because a project that only lists its strengths is selling
something.

- The single ingest worker is a single point of failure. It is also the only
  way to keep upstream cost constant; the mitigation is fast restart, not
  replication.
- Observations are thinned after 48 h, so sub-5-minute resolution is not
  available for old events.
- `AIRSPACE_VOID` needs roughly a week of samples before its baseline can fire.
  A fresh deployment gets **quieter**, not louder, over its first week.
- A receiver outage in a feed looks identical to an emptied sky. That is why
  ingest health is on the front page rather than buried.
- No photorealistic globe, no 3D terrain, no imagery layer.

---

## Licence and data

Code: **AGPL-3.0-or-later**. If you run a modified version as a network
service, you publish your changes.

Data: each feed carries its own terms, listed in `/api/sources` and in
[`docs/DATA-SOURCES.md`](docs/DATA-SOURCES.md). **Read them before deploying
anything commercial** — OpenSky in particular is CC BY-SA 4.0 and
non-commercial without a separate agreement. The licence risk in a project like
this comes from the feeds, not from the code.

See [`docs/OWNERSHIP.md`](docs/OWNERSHIP.md) for the clean-room provenance of
this codebase.
