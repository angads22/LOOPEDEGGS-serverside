#!/usr/bin/env bash
# ================================================================
#  LifeLoop Hub — deploy / update
#  Run from /opt/lifeloop:  sudo ./deploy.sh
#
#  Pulls the latest commit on the tracked branch, installs prod
#  dependencies, fixes ownership, and restarts the systemd unit.
# ================================================================
set -euo pipefail

APP_DIR="/opt/lifeloop"
APP_USER="lifeloop"
SERVICE="lifeloop"
BRANCH="${BRANCH:-main}"

GRN='\033[0;32m'; YLW='\033[1;33m'; RED='\033[0;31m'; BLU='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GRN}[deploy]${NC} $*"; }
warn() { echo -e "${YLW}[ warn]${NC} $*"; }
die()  { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }
hdr()  { echo -e "\n${BLU}═══ $* ═══${NC}"; }

[[ "$EUID" -eq 0 ]] || die "Run as root: sudo $0"
[[ -d "$APP_DIR/.git" ]] || die "$APP_DIR is not a git checkout — run setup.sh first"

cd "$APP_DIR"

hdr "Pull"
BEFORE="$(git rev-parse --short HEAD)"
sudo -u "$APP_USER" git fetch origin "$BRANCH"
sudo -u "$APP_USER" git reset --hard "origin/$BRANCH"
AFTER="$(git rev-parse --short HEAD)"

if [[ "$BEFORE" == "$AFTER" ]]; then
  log "Already up to date at $AFTER"
else
  log "Updated $BEFORE → $AFTER"
  echo ""
  git --no-pager log --oneline "$BEFORE..$AFTER" | sed 's/^/  /'
  echo ""
fi

hdr "Dependencies"
sudo -u "$APP_USER" npm ci --omit=dev

hdr "Permissions"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

hdr "Restart"
systemctl restart "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  log "$SERVICE is running"
else
  warn "$SERVICE failed to start — check: journalctl -u $SERVICE -n 50"
  exit 1
fi

hdr "Done"
echo ""
echo -e "  ${GRN}Deployed $AFTER${NC}"
echo -e "  Logs: ${BLU}journalctl -u $SERVICE -f${NC}"
echo ""
