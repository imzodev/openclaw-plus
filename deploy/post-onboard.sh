#!/usr/bin/env bash
# Phase 2: Run AFTER docker-setup.sh onboarding completes.
# Sets up nginx reverse proxy, Let's Encrypt SSL, and clones mission-control addon.
#
# Usage: bash /home/openclaw/deploy/post-onboard.sh
set -euo pipefail

INSTALL_DIR="/home/openclaw"
OPENCLAW_CONFIG_DIR="/root/.openclaw"
DOMAIN="lospinos.club"
EMAIL="imzodev@gmail.com"
MISSION_CONTROL_REPO="https://github.com/imzodev/openclaw-mission-control.git"

# ── 1. Install nginx + certbot ────────────────────────────────────────────────
echo "==> Installing nginx and certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq nginx certbot python3-certbot-nginx

# ── 2. Stop any existing gateway on port 80 (nginx needs it for certbot) ─────
docker compose -f "$INSTALL_DIR/docker-compose.yml" down 2>/dev/null || true

# ── 3. nginx config (HTTP only first so certbot can verify) ──────────────────
echo "==> Writing nginx config"
cat > /etc/nginx/sites-available/openclaw <<'NGINX_EOF'
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 80;
  server_name lospinos.club www.lospinos.club;

  location / {
    proxy_pass         http://127.0.0.1:18789;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        $connection_upgrade;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
NGINX_EOF

ln -sf /etc/nginx/sites-available/openclaw /etc/nginx/sites-enabled/openclaw
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx

# ── 4. Start gateway so port 18789 is up before certbot HTTP challenge ────────
echo "==> Starting openclaw-gateway"
docker compose -f "$INSTALL_DIR/docker-compose.yml" up -d openclaw-gateway

# ── 5. SSL certificate ────────────────────────────────────────────────────────
echo "==> Obtaining SSL certificate for $DOMAIN"
certbot --nginx \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  --redirect \
  -d "$DOMAIN" \
  -d "www.$DOMAIN"

systemctl reload nginx

# ── 6. Clone mission-control addon ───────────────────────────────────────────
ADDON_DEST="$OPENCLAW_CONFIG_DIR/addons/mission-control"
echo "==> Cloning mission-control addon"
if [[ -d "$ADDON_DEST/.git" ]]; then
  git -C "$ADDON_DEST" pull --rebase
else
  rm -rf "$ADDON_DEST"
  git clone --depth 1 "$MISSION_CONTROL_REPO" "$ADDON_DEST"
fi

# ── 7. Restart gateway to pick up the addon ──────────────────────────────────
echo "==> Restarting gateway"
docker compose -f "$INSTALL_DIR/docker-compose.yml" restart openclaw-gateway

# ── 8. Firewall ───────────────────────────────────────────────────────────────
ufw allow 80/tcp  2>/dev/null || true
ufw allow 443/tcp 2>/dev/null || true

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  OpenClaw is live at https://lospinos.club          ║"
echo "║                                                      ║"
echo "║  mission-control addon installed in:                ║"
echo "║  $OPENCLAW_CONFIG_DIR/addons/mission-control        ║"
echo "║                                                      ║"
echo "║  Logs:                                               ║"
echo "║  docker compose -f $INSTALL_DIR/docker-compose.yml  ║"
echo "║    logs -f openclaw-gateway                          ║"
echo "╚══════════════════════════════════════════════════════╝"
