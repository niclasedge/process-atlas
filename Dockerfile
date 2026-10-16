# --- stage 1: the viewer bundle -------------------------------------------
FROM node:22-alpine AS web
WORKDIR /build
# Lockfile first so a dependency-free code change reuses the install layer.
COPY web/package.json web/pnpm-lock.yaml* ./
# corepack takes the version from package.json's `packageManager`. Without that
# pin it installs whatever is current -- pnpm 11 turned the "ignored build
# scripts" warning into a hard error, so the image failed to build while the
# same install passed locally on pnpm 10.
RUN corepack enable && pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# --- stage 2: the server, compiled ----------------------------------------
FROM denoland/deno:2.9.2 AS server
WORKDIR /build
COPY deno.json deno.lock* ./
COPY server/ ./server/
# `deno compile` bakes the runtime, the sources and the resolved dependencies
# into one executable. The payoff is at start-up and at rest: the final image
# carries no Deno CLI, resolves no imports and reads no lockfile when the
# container starts.
#
# The permissions are baked in too, and `--allow-write=/srv/diagrams` is the one
# that earns its place: edit mode's PUT and POST write through this process, so
# bounding the writable part of the filesystem to the corpus is a real limit and
# not a formality.
#
# The heap cap that makes this small lives in the runtime stage as
# DENO_V8_FLAGS, not here: `deno compile --v8-flags=` applies the flags to the
# compiler's own V8 as well, and the compile then dies of the very limit it was
# meant to bake in (exit 133, V8 OOM).
RUN deno compile \
      --allow-net \
      --allow-env \
      --allow-read \
      --allow-write=/srv/diagrams \
      --output /build/atlas \
      server/main.ts

# --- stage 3: runtime ------------------------------------------------------
# distroless/cc: glibc and nothing else. `deno compile` emits a glibc binary
# (there is no musl target), so Alpine would need a compatibility shim, and a
# full Debian would add ~50 MB of userland for the one thing it was needed for
# -- curl in the healthcheck, which `atlas --health` replaces.
FROM gcr.io/distroless/cc-debian12

COPY --from=server /build/atlas /usr/local/bin/atlas
WORKDIR /srv
COPY --from=web /build/dist ./web/dist
# The corpus travels with the image: a viewer whose diagrams are missing starts
# fine and shows nothing, which reads as "no processes" rather than "bad build".
COPY diagrams/ ./diagrams/
# Rendered on the controller by `just previews`, because rendering needs a
# Chrome and a hover preview has to be instant. Missing PNGs are not fatal --
# the frontend then renders an SVG per hover, which is slow enough to notice.
COPY previews/ ./previews/

# DENO_V8_FLAGS is the memory lever: 93 MiB resident without it, 20 MiB with it,
# measured on the original ~15-diagram corpus. V8 sizes its heap for the machine, and on a 16 GB host
# that reservation dwarfs everything this process holds -- a dozen diagrams and
# their index. 48 MB is ~30x the corpus, so the cap bounds the reservation
# without ever being the thing that fails. An env var, not a compile flag, so a
# larger corpus is a compose change rather than a rebuild.
ENV ATLAS_DIAGRAM_DIR=/srv/diagrams \
    ATLAS_STATIC_DIR=/srv/web/dist \
    ATLAS_PREVIEW_DIR=/srv/previews \
    DENO_V8_FLAGS=--max-old-space-size=48

EXPOSE 8080
# nonroot (65532) is the user distroless actually declares; `nobody` exists too
# but owns nothing here. Edit mode needs the mounted diagrams/ writable by this
# uid -- read-only serving does not.
USER nonroot

# /health is 503 on an empty or unparsable corpus, so this catches the case the
# process itself survives -- a container up with nothing to show. Exec form,
# because distroless has no shell to parse `||`.
HEALTHCHECK --interval=60s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/usr/local/bin/atlas", "--health"]

CMD ["atlas"]
