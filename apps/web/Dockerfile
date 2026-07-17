# syntax=docker/dockerfile:1.7
# Switchboard web image (ARCHITECTURE §8): build the React/Vite SPA to static
# files, serve them from a non-root nginx with SPA fallback + gzip + security
# headers + reverse proxy to the api (see deploy/web/nginx.conf).
#
# Built in real-API mode (VITE_API_MODE=real) so the bundle talks to the
# same-origin /api + /ws the nginx layer proxies — MSW/mock handlers are excluded.
#
# Multi-stage: pnpm fetch -> vite build -> nginx-unprivileged static runtime.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine
ARG PNPM_VERSION=10.31.0

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PNPM_STORE_DIR=/pnpm/store
ENV PATH=/pnpm:$PATH
# Pin corepack to the requested pnpm; without this it ignores the pin whenever
# it can't see a `packageManager` field and fetches its own latest (a pnpm 12
# alpha), which breaks `pnpm fetch`. (Same fix as apps/api/Dockerfile.)
ENV COREPACK_DEFAULT_TO_LATEST=0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

FROM base AS deps
# package.json carries the `packageManager` pin corepack reads (the lockfile
# alone leaves it guessing — see COREPACK_DEFAULT_TO_LATEST above).
COPY package.json pnpm-lock.yaml ./
RUN pnpm fetch

FROM deps AS build
COPY . .
RUN pnpm install -r --offline --frozen-lockfile
# Same-origin API, root base path. The web build also runs `tsc --noEmit`.
ENV VITE_API_MODE=real
ENV VITE_BASE=/
RUN pnpm --filter @switchboard/web run build

# ---- runtime: non-root nginx serving the static build ----
FROM ${NGINX_IMAGE} AS runtime
# COPY needs root; the base image otherwise runs as the unprivileged nginx user.
USER root
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
# Drop back to the image's built-in unprivileged user (uid 101).
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q -O - http://127.0.0.1:8080/nginx-health || exit 1
