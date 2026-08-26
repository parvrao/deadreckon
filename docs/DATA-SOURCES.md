# Data sources

Every feed DEADRECKON touches, what it is used for, and the terms it comes
under. The same table is served live at `/api/sources` with current health, so
attribution is structurally hard to forget.

**None of this data is classified. None of it is obtained by any means other
than a public HTTP request.**

---

## Air — ADS-B

### adsb.lol · default, no key
`https://api.adsb.lol/v2/...` · ODbL 1.0 · [docs](https://api.adsb.lol/docs)

Community-fed ADS-B. Used for the watchbox circles, the global military query,
and the three emergency squawks.

We poll *targeted*, not exhaustively: watchbox circles capped at the provider's
250 nm radius, plus `/v2/mil`, `/v2/squawk/7700|7600|7500`. Scraping the whole
sky every ten seconds would be antisocial, would get us rate-limited within the
hour, and would bury the signal.

Fields that matter downstream: `hex`, `lat`, `lon`, `gs`, `track`, `alt_baro`,
`squawk`, `emergency`, and crucially **`nic` / `nac_p`** — the navigation
integrity categories that make `GNSS_BLOOM` possible.

> **ODbL share-alike may reach derived databases.** If you redistribute the
> `observation` table, read the licence first.

### OpenSky Network · optional, OAuth2
`https://opensky-network.org/api/states/all` · CC BY-SA 4.0 ·
[docs](https://openskynetwork.github.io/opensky-api/)

Global state vectors in a single call. Enabled only when
`OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` are set.

> **This is the highest-risk feed in the project.** CC BY-SA 4.0 and
> **non-commercial without a separate agreement**. Share-alike may also reach
> derived datasets. Leave the credentials unset unless you have read the terms
> and they fit your use.

---

## Sea — AIS

### aisstream.io · required for the flagship rule
`wss://stream.aisstream.io/v0/stream` · free tier, attribution ·
[docs](https://aisstream.io/documentation)

A **push** feed, not a poll feed — which is exactly right for dark-vessel work.
A poll can only tell you a ship was absent from the last snapshot; a stream
tells you the instant it stopped talking.

Subscribed message types: `PositionReport`, `ShipStaticData`. Static data
carries name, ITU-R M.1371 ship type, IMO and call sign, and is cached and
merged onto position reports — **the ship type selects the kinematic profile,
so a wrong type means a wrong speed ceiling and a wrong verdict.**

Sentinel handling that matters: `Sog == 102.3` and `Cog >= 360` mean
"unavailable", and `lat 91 / lon 181` mean "not set". Letting those through
puts ghost hulls at the poles and on the prime meridian.

Without `AISSTREAM_API_KEY` the sea domain is disabled and `DARK_VESSEL`,
`SPOOF_DISCONTINUITY` and `RENDEZVOUS` cannot fire at all.

---

## Orbit

### CelesTrak · no key
`https://celestrak.org/NORAD/elements/gp.php?GROUP=...&FORMAT=tle` ·
USSF catalogue (public domain) under CelesTrak terms ·
[docs](https://celestrak.org/NORAD/elements/)

Groups fetched: `stations`, `visual`, `resource`, `sarsat`, `planet`, `spire`,
`starlink`. Not `active` — that is 11k+ objects and mostly debris. A group that
does not exist on a mirror fails silently and is not treated as an error.

**Elements are stored, never propagated server-side.** A satellite's position
is a deterministic function of (elements, time), so the browser runs SGP4
locally. The orbital layer costs the backend one fetch every six hours and
exactly nothing per viewer.

> Bulk redistribution has conditions. Check before mirroring the catalogue.

---

## Geo — seismic

### USGS · no key
`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson` ·
US Government work, public domain ·
[docs](https://earthquake.usgs.gov/earthquakes/feed/)

Shallow matters more than large here: M4 at 0 km is a surface profile, M6 at
300 km is a subduction zone doing what it always does. `SEISMIC_SHALLOW` fires
on M ≥ 3.2 at ≤ 6 km.

> Preliminary depths are frequently revised, often substantially. This is the
> single biggest source of false positives in the geo domain, and it is stated
> in every evidence bundle.

---

## Thermal

### NASA FIRMS · free key
`https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/VIIRS_NOAA20_NRT/{W,S,E,N}/1` ·
NASA open data, attribution required ·
[docs](https://firms.modaps.eosdis.nasa.gov/api/)

VIIRS at 375 m. Enough to see a burning facility, a struck vessel, or a flare
stack going out. FRP (fire radiative power) is the discriminator between a
cooking fire and an event; the threshold is 40 MW.

> FIRMS answers **HTTP 200 with an HTML body** when the key is invalid. The
> adapter checks for that explicitly rather than trusting the status code.

---

## Media

### GDELT 2.0 · no key
`https://api.gdeltproject.org/api/v2/doc/doc` · free with attribution ·
[docs](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)

Corroboration only. A detection with no reporting around it is still a
detection; one with reporting is an incident with a name and citations.

---

## Basemap

### CARTO dark-matter-nolabels
`https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json` ·
free with attribution · © OpenStreetMap contributors © CARTO

**Do not remove the attribution control.** It is required, and it costs one
line of screen.

---

## The rules that keep this honest

1. **If we cannot state the licence for a feed, we do not ingest the feed.**
   `packages/core/src/sources.ts` is the single registry; adding a source
   without filling in `license` is the one thing that should fail review.

2. **Ingest health is on the front page.** A dead feed looks identical to a
   quiet world, and that mistake turns a missing signal into a false detection.
   `/api/sources` shows consecutive errors, last success, and last error text.

3. **Every fetch is hashed and chained.** `chain[n] = sha256(chain[n-1] ||
   sha256(payload[n]))`. Recompute at `/api/provenance/verify`.

4. **Before any commercial use, re-read every licence above.** Terms change,
   and the two with share-alike clauses — OpenSky and adsb.lol — are the ones
   that can reach into what you build on top. See
   [`OWNERSHIP.md`](OWNERSHIP.md).
