#!/usr/bin/env bash
# ================================================================
#  LifeLoop Hub — Raspberry Pi 5 Setup Script
#  Target: loopedeggs.ca  |  Node 20 + Nginx + SSL + systemd
# ================================================================
set -euo pipefail

DOMAIN="loopedeggs.ca"
WWW="www.loopedeggs.ca"
APP_DIR="/opt/lifeloop"
APP_USER="lifeloop"
NODE_MAJOR="20"
ADMIN_EMAIL="admin@loopedeggs.ca"

# ── Colours ──────────────────────────────────────────────────────
GRN='\033[0;32m'; YLW='\033[1;33m'; RED='\033[0;31m'; BLU='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GRN}[setup]${NC} $*"; }
warn() { echo -e "${YLW}[ warn]${NC} $*"; }
die()  { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }
hdr()  { echo -e "\n${BLU}═══ $* ═══${NC}"; }

# ── Root check ───────────────────────────────────────────────────
[[ "$EUID" -eq 0 ]] || die "Run as root:  sudo bash setup.sh"

# ── Must be run from the repo directory ──────────────────────────
[[ -f server.js ]] || die "Run this script from the lifeloop repo root (where server.js lives)"

hdr "Purging conflicting web servers"
for svc in apache2 lighttpd; do
  systemctl stop "$svc" 2>/dev/null && log "Stopped $svc" || true
  apt-get purge -y "$svc" 2>/dev/null && log "Purged $svc"  || true
done
apt-get autoremove -y -qq

hdr "System update"
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget git ufw fail2ban certbot python3-certbot-nginx

hdr "Node.js $NODE_MAJOR"
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.version.slice(1).split(\".\")[0])')" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
log "Node $(node -v)  /  npm $(npm -v)"

hdr "Nginx"
apt-get install -y nginx
systemctl enable nginx

hdr "App user & directory"
id -u "$APP_USER" &>/dev/null || useradd -r -s /bin/false -d "$APP_DIR" "$APP_USER"
mkdir -p "$APP_DIR"

# Copy repo to app dir (excluding node_modules / .git)
rsync -a --exclude node_modules --exclude .git --exclude "*.log" \
      "$(pwd)/" "$APP_DIR/"
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

hdr "Node dependencies"
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev
cd - >/dev/null

hdr "Environment file"
if [[ ! -f "$APP_DIR/.env" ]]; then
  cat > "$APP_DIR/.env" <<ENV
NODE_ENV=production
PORT=3000
ALLOWED_ORIGINS=https://$DOMAIN,https://$WWW
ENV
  chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  log "Created $APP_DIR/.env"
fi

hdr "Nginx — initial HTTP config (pre-SSL)"
# Bootstrap with HTTP-only so certbot can do its challenge
cat > /etc/nginx/sites-available/loopedeggs <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN $WWW;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/loopedeggs /etc/nginx/sites-enabled/loopedeggs
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

hdr "systemd service"
cat > /etc/systemd/system/lifeloop.service <<SVC
[Unit]
Description=LifeLoop Hub — loopedeggs.ca
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=lifeloop

Environment=NODE_ENV=production
EnvironmentFile=-$APP_DIR/.env

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$APP_DIR/data

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable lifeloop
systemctl start lifeloop
sleep 2
systemctl is-active --quiet lifeloop && log "lifeloop.service is running" \
  || warn "lifeloop.service may not have started — check: journalctl -u lifeloop"

hdr "SSL — Let's Encrypt"
warn "Your DNS A/AAAA records must already point $DOMAIN and $WWW to this Pi's public IP."
read -rp "  Press Enter to request the certificate (Ctrl-C to skip) …"

if certbot --nginx \
     -d "$DOMAIN" -d "$WWW" \
     --non-interactive --agree-tos \
     --email "$ADMIN_EMAIL" \
     --redirect; then
  log "SSL certificate installed"
  # Install the production nginx config with SSL stanzas
  cp "$(dirname "$0")/nginx/loopedeggs.conf" /etc/nginx/sites-available/loopedeggs
  nginx -t && systemctl reload nginx && log "Nginx reloaded with SSL config"
else
  warn "Certbot failed — the site is running on HTTP. Re-run certbot manually when DNS is ready:"
  warn "  certbot --nginx -d $DOMAIN -d $WWW --email $ADMIN_EMAIL"
fi

hdr "Firewall (UFW)"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow http
ufw allow https
ufw --force enable
log "UFW enabled (ssh/http/https)"

hdr "fail2ban"
systemctl enable fail2ban
systemctl start fail2ban

hdr "SSL auto-renewal"
systemctl enable certbot.timer 2>/dev/null || \
  (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && nginx -s reload") | crontab -
log "Auto-renewal configured"

hdr "Done"
echo ""
echo -e "  ${GRN}LifeLoop Hub is live!${NC}"
echo ""
echo -e "  Site:           ${BLU}https://$DOMAIN${NC}"
echo -e "  App directory:  ${BLU}$APP_DIR${NC}"
echo -e "  Logs:           ${BLU}journalctl -u lifeloop -f${NC}"
echo -e "  Status:         ${BLU}systemctl status lifeloop${NC}"
echo -e "  Nginx logs:     ${BLU}tail -f /var/log/nginx/access.log${NC}"
echo ""
