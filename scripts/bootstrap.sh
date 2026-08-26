#!/usr/bin/env bash
#
# DEADRECKON :: bootstrap
#
# Creates the GitHub repo, commits, pushes, and prints exactly what to click
# on Render. Run it once, from the repo root.
#
#   bash scripts/bootstrap.sh [repo-name] [public|private]
#
set -euo pipefail

REPO="${1:-deadreckon}"
VIS="${2:-public}"

say()  { printf '\033[38;5;214m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[38;5;42m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[38;5;214m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[38;5;203m✗\033[0m %s\n' "$*" >&2; exit 1; }

cat <<'BANNER'

 ██████╗ ███████╗ █████╗ ██████╗
 ██╔══██╗██╔════╝██╔══██╗██╔══██╗   R E C K O N
 ██║  ██║█████╗  ███████║██║  ██║
 ██║  ██║██╔══╝  ██╔══██║██║  ██║   always on
 ██████╔╝███████╗██║  ██║██████╔╝   nobody has to press record
 ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═════╝

BANNER

# ---------------------------------------------------------------- checks

say "[1/5] preflight"
command -v git >/dev/null || die "git is not installed"
command -v node >/dev/null || die "node is not installed"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node >= 20 required (found $(node -v))"
ok "node $(node -v)"

[ -f render.yaml ] || die "run this from the repo root (render.yaml not found)"

# GitHub only detects the licence when the canonical text is present.
if ! grep -q "GNU AFFERO GENERAL PUBLIC LICENSE" LICENSE 2>/dev/null; then
  if curl -fsSL https://www.gnu.org/licenses/agpl-3.0.txt >> LICENSE 2>/dev/null; then
    ok "appended the full AGPL-3.0 text to LICENSE"
  else
    warn "could not fetch the AGPL text -- append it manually before publishing:"
    warn "  curl -fsSL https://www.gnu.org/licenses/agpl-3.0.txt >> LICENSE"
  fi
else
  ok "LICENSE complete"
fi

HAS_GH=0
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  HAS_GH=1
  ok "gh authenticated as $(gh api user -q .login)"
else
  warn "gh CLI not found or not authenticated -- will print manual steps"
fi

# ------------------------------------------------------------- build first

say "[2/5] install and build (proving it compiles before it is published)"
npm ci --silent
npm run build --silent
ok "all workspaces built"

npm test --silent && ok "28 unit tests pass" || die "tests failed -- not publishing a broken tree"

# ----------------------------------------------------------------- commit

say "[3/5] git"
if [ ! -d .git ]; then
  git init -q -b main
  ok "initialised"
fi

# A stale index.lock is left behind when a previous git run was killed, and
# it blocks every subsequent write with a confusing message.
if [ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1; then
  rm -f .git/index.lock .git/HEAD.lock .git/objects/maintenance.lock 2>/dev/null || true
  ok "cleared a stale git lock"
fi

# macOS drops .DS_Store into build output, and vite refuses to empty a
# directory it cannot fully remove.
find . -name '.DS_Store' -not -path './node_modules/*' -delete 2>/dev/null || true

git add -A
if git diff --cached --quiet; then
  ok "nothing new to commit"
else
  git commit -q -m "DEADRECKON: always-on OSINT detection, provenance, and replay

Original clean-room implementation. See docs/OWNERSHIP.md.

- dead-reckoning reachable-set verdicts for dark targets
- CONFLUENCE cross-modality fusion rule
- sha256 provenance hash chain with public verification
- 28-byte binary wire protocol, geohash-addressed fan-out
- append-only archive with tiered retention; no record button"
  ok "committed $(git rev-parse --short HEAD)"
fi

# ------------------------------------------------------------------ push

say "[4/5] github"
if git remote get-url origin >/dev/null 2>&1; then
  ok "origin already set: $(git remote get-url origin)"
  git push -u origin main && ok "pushed"
elif [ "$HAS_GH" = "1" ]; then
  gh repo create "$REPO" "--$VIS" --source=. --remote=origin --push \
    --description "Always-on open-source spatial intelligence. Detection, not decoration."
  ok "created and pushed: $(gh repo view --json url -q .url)"
else
  cat <<EOF

  Create the repo manually, then:

    git remote add origin git@github.com:<you>/$REPO.git
    git push -u origin main

EOF
fi

# ---------------------------------------------------------------- render

say "[5/5] render"
cat <<'EOF'

  1. https://dashboard.render.com  ->  New  ->  Blueprint  ->  this repo  ->  Apply

     render.yaml provisions four things:
       deadreckon-db      postgres   (free tier EXPIRES AFTER 30 DAYS)
       deadreckon-api     web        free   -- api + websocket hub
       deadreckon-ingest  worker     starter -- workers are not on the free tier
       deadreckon-web     static     free

  2. On deadreckon-ingest, set:
       AISSTREAM_API_KEY    https://aisstream.io           <- without this the
                                                              sea domain is off
                                                              and DARK_VESSEL,
                                                              the flagship rule,
                                                              cannot fire
       FIRMS_MAP_KEY        https://firms.modaps.eosdis.nasa.gov/api/   (optional)

  3. On deadreckon-web, set both to the deadreckon-api URL, then redeploy:
       VITE_API_URL   https://deadreckon-api.onrender.com
       VITE_WS_URL    wss://deadreckon-api.onrender.com/stream

  4. On deadreckon-api, set:
       CORS_ORIGIN    https://deadreckon-web.onrender.com

  5. Confirm it is alive:
       curl https://deadreckon-api.onrender.com/api/health
       curl https://deadreckon-api.onrender.com/api/stats

  For anything permanent, replace the free Postgres with Neon or Supabase:
  set DATABASE_URL on BOTH services and delete the databases: block.

  Expect silence at first. AIRSPACE_VOID needs about a week of samples before
  its baseline can fire at all. A fresh deployment gets quieter, not louder.

EOF

say "done."
