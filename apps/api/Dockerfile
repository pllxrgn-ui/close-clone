# syntax=docker/dockerfile:1.7
# Switchboard API / worker image (ARCHITECTURE §8). ONE image; role chosen at
# runtime by APP_ROLE (server | worker) via deploy/scripts/entrypoint.sh.
#
# This repo emits NO JavaScript — it runs TypeScript source directly through
# Node's type stripping (apps/api "start": `node src/index.ts`; @switchboard/shared
# is consumed as .ts via its exports). The runtime therefore ships the TS source
# plus a pnpm-workspace node_modules, so `@switchboard/shared` resolves through its
# symlink to a real path OUTSIDE node_modules — the only layout Node's
# --experimental-strip-types accepts for TypeScript dependencies.
#
# Multi-stage: pnpm fetch (cacheable store) -> build (install + typecheck gate) ->
# prod (production-only node_modules) -> slim non-root runtime.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=10.31.0

# ---- base: node + pnpm (store kept OUTSIDE /app so it never lands in runtime) ----
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PNPM_STORE_DIR=/pnpm/store
ENV PATH=/pnpm:$PATH
# COREPACK_DEFAULT_TO_LATEST=0: without it, corepack ignores the pinned version
# above whenever it cannot see a `packageManager` field and downloads its own
# "latest" (a pnpm 12 alpha), which broke `pnpm fetch` below. Pin, never drift.
ENV COREPACK_DEFAULT_TO_LATEST=0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ---- deps: warm the content-addressable store from the lockfile (cache layer) ----
FROM base AS deps
# package.json comes along for its `packageManager` pin — the lockfile alone
# leaves corepack guessing (see COREPACK_DEFAULT_TO_LATEST above). It changes
# about as rarely as the lockfile, so the cache layer is just as stable.
COPY package.json pnpm-lock.yaml ./
RUN pnpm fetch

# ---- build: full install + the typecheck gate (fails the image on any TS error) ----
FROM deps AS build
COPY . .
RUN pnpm install -r --offline --frozen-lockfile
RUN pnpm --filter @switchboard/shared --filter @switchboard/api run build
RUN touch /app/.build-ok

# ---- prod: production-only node_modules for api (+ its workspace dep, shared) ----
FROM base AS prod
# Manifests first so the workspace graph validates against the frozen lockfile.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY fixtures/package.json fixtures/
COPY --from=deps /pnpm/store /pnpm/store
# Filtered prod install keeps web/tooling deps out of the runtime image.
# Fallback if a pnpm filter edge-case bites: drop the --filter to install the
# whole workspace's prod deps (larger image, same behaviour).
RUN pnpm install --prod --offline --frozen-lockfile --filter @switchboard/api...
# Only the api + shared TS source is needed at runtime (no web source).
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared
# migrate.mjs sits next to the api node_modules so `pg` / `drizzle-orm` resolve.
COPY deploy/scripts/migrate.mjs ./apps/api/migrate.mjs

# ---- runtime: slim, non-root, TS source + prod node_modules (no store, no dev deps) ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV APP_ROLE=server
ENV PORT=3000
WORKDIR /app
# `node` (uid 1000) ships in the official image — run unprivileged.
COPY --from=build /app/.build-ok /app/.build-ok
COPY --from=prod --chown=node:node /app /app
COPY --chown=node:node deploy/scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
USER node
EXPOSE 3000
# Liveness: /healthz (ARCHITECTURE §8). Node 22 has global fetch — no curl needed.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
