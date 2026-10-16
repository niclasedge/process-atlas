default:
    @just --list

# --- corpus ---------------------------------------------------------------

# Pull .bpmn from every repo in sources.yml into diagrams/<repo>/
sync:
    deno run --allow-read --allow-write --allow-env --allow-run scripts/sync.ts

# Render one PNG per process into previews/ — the sidebar's hover cache
previews:
    deno run --allow-read --allow-write --allow-env --allow-run scripts/render-previews.ts

# Re-render every preview, including the ones that look current
previews-force:
    deno run --allow-read --allow-write --allow-env --allow-run scripts/render-previews.ts --force

# Derive process candidates for a repo — Trockenlauf; --write schreibt, --force ersetzt
scaffold REPO *FLAGS:
    deno run --allow-read --allow-write --allow-env scripts/scaffold.ts {{REPO}} {{FLAGS}}

# --- develop --------------------------------------------------------------

# Install frontend deps (pnpm only — npm/npx are not used in this workspace)
install:
    pnpm --dir web install

# Production bundle into web/dist
build:
    pnpm --dir web build

# Server + built frontend on :8080 — what the container runs
serve:
    deno run --allow-net --allow-read --allow-write --allow-env server/main.ts

# Same, with the Neu/Speichern buttons and the write routes enabled
edit:
    ATLAS_EDIT=1 deno run --allow-net --allow-read --allow-write --allow-env server/main.ts

# Server with reload; run `just dev-web` next to it for hot module reload
dev:
    deno run --watch --allow-net --allow-read --allow-write --allow-env server/main.ts

# Vite dev server on :5173, proxying /api and /health to `just dev`
dev-web:
    pnpm --dir web dev

test:
    deno test --allow-read --allow-write --allow-env --allow-run

# Typen + Lint. web/ ist in deno.json von lint ausgenommen: dort ist `window`
# der richtige Globalname, deno lint meldet jede Nutzung — Vite prüft das.
check:
    deno check server/ scripts/*.ts && deno lint

# --- container ------------------------------------------------------------

# Full local stack in Docker on :8088
up:
    docker compose up -d --build

down:
    docker compose down

# What a monitoring check polls — 200 only when the corpus parses and is non-empty
health:
    @curl -fsS localhost:8080/health || curl -fsS localhost:8088/health
