#!/usr/bin/env bash
# =============================================================================
#  LifeLoop Hub — Linux/macOS deploy script
#
#  ./scripts/deploy.sh                       # pull :latest and start
#  ./scripts/deploy.sh --tag v1.0.0          # pin a version
#  ./scripts/deploy.sh --no-watchtower       # disable auto-updates
#  ./scripts/deploy.sh --local               # use a locally-built image
# =============================================================================
set -euo pipefail

TAG="latest"
REGISTRY="ghcr.io/angads22/loopedeggs-serverside"
LOCAL=0
NO_WATCHTOWER=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)            TAG="$2"; shift 2 ;;
    --registry)       REGISTRY="$2"; shift 2 ;;
    --local)          LOCAL=1; shift ;;
    --no-watchtower)  NO_WATCHTOWER=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

if [[ $LOCAL -eq 1 ]]; then
  export LIFELOOP_IMAGE="lifeloop-hub:${TAG}"
else
  export LIFELOOP_IMAGE="${REGISTRY}:${TAG}"
fi

echo "==> Deploying $LIFELOOP_IMAGE"

if [[ $LOCAL -eq 0 ]]; then
  docker compose pull lifeloop
fi

services=(lifeloop)
[[ $NO_WATCHTOWER -eq 0 ]] && services+=(watchtower)

docker compose up -d "${services[@]}"

echo "==> Waiting for healthcheck"
for _ in {1..30}; do
  status="$(docker inspect --format '{{.State.Health.Status}}' lifeloop 2>/dev/null || echo starting)"
  echo "  status: $status"
  [[ "$status" == "healthy" ]] && {
    echo "[ ok ] lifeloop is healthy — http://localhost:3000"
    exit 0
  }
  sleep 2
done

echo "[warn] lifeloop did not report healthy within 60s. docker compose logs lifeloop" >&2
exit 1
