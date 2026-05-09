#!/usr/bin/env bash
# =============================================================================
#  LifeLoop Hub — Linux/macOS build script
#  Mirrors scripts/build.ps1.
#
#  Examples:
#    ./scripts/build.sh                                    # local single-arch
#    ./scripts/build.sh --tag v1.0.0                       # tagged build
#    ./scripts/build.sh --multi-arch --push \
#        --registry ghcr.io/angads22/loopedeggs-serverside \
#        --tag v1.0.0
# =============================================================================
set -euo pipefail

TAG="dev"
REGISTRY="lifeloop-hub"
PLATFORMS="linux/amd64,linux/arm64"
MULTI_ARCH=0
PUSH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)         TAG="$2"; shift 2 ;;
    --registry)    REGISTRY="$2"; shift 2 ;;
    --platforms)   PLATFORMS="$2"; shift 2 ;;
    --multi-arch)  MULTI_ARCH=1; shift ;;
    --push)        PUSH=1; shift ;;
    -h|--help)
      sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

docker version >/dev/null

VCS_REF="$(git rev-parse --short HEAD 2>/dev/null || echo local)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
IMAGE="${REGISTRY}:${TAG}"

echo "  Image     : $IMAGE"
echo "  Revision  : $VCS_REF"
echo "  BuildDate : $BUILD_DATE"

COMMON=(
  --build-arg "VERSION=$TAG"
  --build-arg "VCS_REF=$VCS_REF"
  --build-arg "BUILD_DATE=$BUILD_DATE"
  -t "$IMAGE"
)

if [[ $MULTI_ARCH -eq 1 ]]; then
  if ! docker buildx ls | grep -q lifeloop-builder; then
    docker buildx create --name lifeloop-builder --driver docker-container --use
    docker buildx inspect --bootstrap >/dev/null
  else
    docker buildx use lifeloop-builder
  fi

  OUTPUT="--output=type=oci,dest=lifeloop-hub.oci.tar"
  [[ $PUSH -eq 1 ]] && OUTPUT="--push"

  docker buildx build --platform "$PLATFORMS" "${COMMON[@]}" $OUTPUT .
else
  docker build "${COMMON[@]}" .
  [[ $PUSH -eq 1 ]] && docker push "$IMAGE"
fi

echo
echo "Built $IMAGE"
