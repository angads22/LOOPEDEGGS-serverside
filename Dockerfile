# syntax=docker/dockerfile:1.7
# ============================================================================
#  LifeLoop Hub — production container
#  Multi-stage, multi-arch (linux/amd64 + linux/arm64 for Raspberry Pi 5)
#  Final image runs Node 20 Alpine as a non-root user with a healthcheck.
# ============================================================================

ARG NODE_VERSION=20.18.1

# ---- Stage 1: install production dependencies -----------------------------
FROM node:${NODE_VERSION}-alpine AS deps

WORKDIR /app

# Copy lockfile first for better layer caching
COPY package.json package-lock.json ./

# Reproducible install, prod-only, no audit/fund noise in CI
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ---- Stage 2: minimal runtime image ---------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime

# OCI metadata — populated by buildx via build-args from CI
ARG VERSION=dev
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="LifeLoop Hub" \
      org.opencontainers.image.description="LifeLoop Hub — central server for loopedeggs.ca" \
      org.opencontainers.image.source="https://github.com/angads22/loopedeggs-serverside" \
      org.opencontainers.image.url="https://loopedeggs.ca" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

# tini gives us proper PID 1 signal handling (SIGTERM → graceful shutdown)
# wget is used for the HEALTHCHECK
RUN apk add --no-cache tini wget && \
    addgroup -S -g 10001 lifeloop && \
    adduser  -S -u 10001 -G lifeloop -h /app lifeloop

WORKDIR /app

# App code + production node_modules
COPY --chown=lifeloop:lifeloop --from=deps /app/node_modules ./node_modules
COPY --chown=lifeloop:lifeloop package.json package-lock.json ./
COPY --chown=lifeloop:lifeloop server.js ./
COPY --chown=lifeloop:lifeloop public ./public

# Persistent data volume (contacts.json, future state)
RUN mkdir -p /app/data && chown -R lifeloop:lifeloop /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

EXPOSE 3000

USER lifeloop

# Container-native healthcheck — hits the app's /api/health endpoint.
# Compose / Swarm / Kubernetes will use this to gate restarts and readiness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
