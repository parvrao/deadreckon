# Ownership and clean-room provenance

*Written to be checkable, not reassuring. Not legal advice — see the last
section for what a lawyer still needs to look at.*

---

## The short version

Every line of code in this repository was written from public API
documentation and first principles. No third-party OSINT codebase was read,
copied, adapted, decompiled, or referenced during its construction.

That is unusually easy to demonstrate here, for a specific reason.

## Why there was nothing to copy

The obvious comparison is Bilawal Sidhu's **God's Eye View / WorldView**, a
3D-globe OSINT viewer that went viral in early 2026.

As of the date this repository was created, that project's public repository
[`bilawalsidhu/gods-eye-view`](https://github.com/bilawalsidhu/gods-eye-view)
contained **no source code**. Its README stated: *"Code is being prepared for
public release, targeting July 2026."* The GitHub contents API returned an
empty listing for the repository root. The repository held a README, marketing
imagery, and links to video content.

**Verify this yourself** rather than taking it on trust:

```bash
curl -s https://api.github.com/repos/bilawalsidhu/gods-eye-view/contents/
curl -s https://api.github.com/repos/bilawalsidhu/gods-eye-view/commits | head
```

There was no expression available to copy, so none was copied. This is the
cleanest possible position: not "we were careful," but "the material did not
exist in a readable form."

## What is shared, and why that is fine

Both projects fuse ADS-B, AIS, orbital elements and other public feeds onto a
map. That overlap is at the level of **idea and subject matter**, which
copyright does not reach. The relevant doctrine is the idea/expression
distinction: fusing public data feeds onto a map is a concept, not a work.
Bilawal did not invent it either — Flightradar24, MarineTraffic, ADS-B
Exchange, Kpler and others predate both projects by a decade.

There is also no shared expression in the parts that matter:

| | God's Eye View | DEADRECKON |
|---|---|---|
| Purpose | render live feeds | detect anomalies without a watcher |
| Capture | human tells an agent to start recording | never stops; there is no record button |
| Fusion | manual, retrospective, hand-assembled | `CONFLUENCE` rule, cross-modality gate, ~30 s |
| Rendering | photorealistic 3D globe | 2D deck.gl instrument console |
| Transport | not published | custom 28-byte binary protocol, geohash fan-out |
| Provenance | not published | sha256 hash chain per source, public verify endpoint |
| Output | a visualization | an evidence bundle with stated limitations |

The differentiators — the reachable-set verdict, the corroboration-gated
meta-rule, the tamper-evident archive, the binary wire format — have no
counterpart in the other project's public description at all.

## The name

"Dead reckoning" is a centuries-old navigational term of art: estimating a
current position from a last known fix plus heading, speed and elapsed time.
It is used here descriptively, because it is literally the algorithm in
`packages/core/src/deadreckon.ts`.

**Open item for you, not for a code review:** run a trademark clearance search
(USPTO TESS, EUIPO eSearch, and a domain/handle sweep) before putting the name
on anything commercial or on merchandise. A descriptive term is harder for
someone else to own, but that is a lawyer's call and not an engineer's.

## The licence choice, and why it is defensive

**AGPL-3.0-or-later.** Two consequences worth understanding:

1. Anyone who takes this and runs a modified version as a network service must
   publish their modifications. Someone forking it into a closed hosted product
   is the realistic risk with a project like this, and the AGPL is the standard
   answer to exactly that.
2. **You hold the copyright.** A licence is a grant *you* make, and it does not
   transfer ownership. If you later want a closed-source or commercially
   licensed version, you can dual-license it, because a sole copyright holder
   is not bound by the terms they offered to everyone else.

Keep it that way: if you accept outside contributions, either require a CLA or
keep them small and clearly separable. A large unassigned contribution is the
usual way sole ownership quietly disappears.

## Establishing the record

Do these once, at the start, while it is cheap:

1. **First commit before first publication.** Git history with authored
   timestamps is the ordinary evidence of independent creation. Sign your
   commits (`git config commit.gpgsign true`) if you want it to be stronger.
2. **Keep this file in the repo** and dated. A contemporaneous statement of
   clean-room provenance is worth considerably more than one written later
   during a dispute.
3. **US registration is optional but cheap.** Copyright exists on creation, but
   registration with the US Copyright Office (~$45, source deposit) is a
   prerequisite for statutory damages in US litigation. Worth doing if this
   becomes anything.
4. **Do not import their assets.** No screenshots, no logo, no branding, no
   README imagery, no video stills — not even for a comparison table. Their
   README images are theirs, and that is the one easy way to create a real
   problem out of nothing.

## Where the actual legal risk lives

Not with Bilawal. With the data feeds.

| Feed | Terms | What to watch |
|---|---|---|
| OpenSky Network | CC BY-SA 4.0 | **Non-commercial without a separate agreement.** Share-alike may also reach derived datasets. The highest-risk feed here. |
| aisstream.io | Free tier, attribution | Check current terms for redistribution and commercial use before charging anyone. |
| adsb.lol | ODbL 1.0 | Share-alike on derived *databases*. Attribution required. |
| NASA FIRMS | NASA open data | Attribution required. Effectively unrestricted. |
| USGS | US Government work | Public domain. |
| CelesTrak | USSF catalogue, CelesTrak terms | Bulk redistribution has conditions; check before mirroring. |
| CARTO basemaps | Free with attribution | Do not strip the attribution control. |

Two practical rules:

- The `/api/sources` endpoint exists partly so attribution is structurally
  impossible to forget. Do not remove it.
- Before any commercial use, re-read every row above. Terms change, and the
  ones with share-alike clauses (OpenSky, adsb.lol) are the ones that can
  reach into what you build on top.

## What a lawyer should still look at

Be honest that these are open, rather than pretending the list is empty:

- Trademark clearance on the name in your target jurisdictions.
- Whether OpenSky's non-commercial clause is triggered by your intended use,
  and whether its share-alike reaches your detection outputs.
- Whether ODbL share-alike (adsb.lol) applies to the `observation` table as a
  derived database.
- Publication liability if you name vessels or aircraft in findings —
  defamation exposure is jurisdiction-dependent, and the disclaimer in every
  evidence bundle is a mitigation, not a shield.
- Export-control and sanctions questions if you ever add a paid tier with
  targeted monitoring of specific flags or operators.

---

*Repository created 2026-08-25. Author: Parv Barot. All code original.*
