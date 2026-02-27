#!/usr/bin/env bash
# Full droplet setup for OpenClaw on lospinos.club
# Run as root: bash /opt/openclaw/deploy/setup-droplet.sh
set -euo pipefail

REPO_URL="https://github.com/imzodev/openclaw-plus.git"
BRANCH="stable-custom"
INSTALL_DIR="/opt/openclaw"
OPENCLAW_CONFIG_DIR="/root/.openclaw"
OPENCLAW_WORKSPACE_DIR="/root/.openclaw/workspace"
DOMAIN="lospinos.club"
EMAIL="imzodev@gmail.com"

# ── 1. System packages ────────────────────────────────────────────────────────
echo "==> Installing system packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git nginx certbot python3-certbot-nginx

# ── 2. Docker ────────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "==> Installing Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
else
  echo "==> Docker already installed"
fi

# ── 3. Clone / update repo ────────────────────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "==> Updating repo"
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --rebase origin "$BRANCH"
else
  echo "==> Cloning repo (branch: $BRANCH)"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

# ── 4. Build Docker image ─────────────────────────────────────────────────────
cd "$INSTALL_DIR"
echo "==> Building Docker image openclaw:local"
docker build -t openclaw:local -f Dockerfile .

# ── 5. Config dirs & openclaw.json ───────────────────────────────────────────
mkdir -p "$OPENCLAW_CONFIG_DIR/identity"
mkdir -p "$OPENCLAW_WORKSPACE_DIR"

GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-$(openssl rand -hex 32)}"
export OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN"

if [[ ! -f "$OPENCLAW_CONFIG_DIR/openclaw.json" ]]; then
  echo "==> Writing openclaw.json"
  cat > "$OPENCLAW_CONFIG_DIR/openclaw.json" <<JSON
{
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "port": 18789,
    "auth": {
      "mode": "token",
      "token": "$GATEWAY_TOKEN"
    }
  }
}
JSON
fi

# ── 6. .env for docker-compose ────────────────────────────────────────────────
cat > "$INSTALL_DIR/.env" <<ENV
OPENCLAW_CONFIG_DIR=$OPENCLAW_CONFIG_DIR
OPENCLAW_WORKSPACE_DIR=$OPENCLAW_WORKSPACE_DIR
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_TOKEN=$GATEWAY_TOKEN
OPENCLAW_IMAGE=openclaw:local
OPENCLAW_EXTRA_MOUNTS=
OPENCLAW_HOME_VOLUME=
OPENCLAW_DOCKER_APT_PACKAGES=
ENV

# ── 7. Start gateway ──────────────────────────────────────────────────────────
echo "==> Starting openclaw-gateway"
docker compose -f "$INSTALL_DIR/docker-compose.yml" up -d openclaw-gateway

# ── 8. Install mission-control addon ─────────────────────────────────────────
ADDON_DEST="$OPENCLAW_CONFIG_DIR/addons/mission-control"
MISSION_CONTROL_REPO="https://github.com/imzodev/openclaw-mission-control.git"
echo "==> Cloning mission-control addon"
if [[ -d "$ADDON_DEST/.git" ]]; then
  git -C "$ADDON_DEST" pull --rebase
else
  rm -rf "$ADDON_DEST"
  git clone --depth 1 "$MISSION_CONTROL_REPO" "$ADDON_DEST"
fi

# ── 9. nginx config (HTTP first, certbot upgrades to HTTPS) ──────────────────
echo "==> Writing nginx config"
cat > /etc/nginx/sites-available/openclaw <<NGINX
map \$http_upgrade \$connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 80;
  server_name $DOMAIN www.$DOMAIN;

  # WebSocket + HTTP proxy to OpenClaw gateway
  location / {
    proxy_pass         http://127.0.0.1:18789;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade           \$http_upgrade;
    proxy_set_header   Connection        \$connection_upgrade;
    proxy_set_header   Host              \$host;
    proxy_set_header   X-Real-IP         \$remote_addr;
    proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto \$scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
NGINX

ln -sf /etc/nginx/sites-available/openclaw /etc/nginx/sites-enabled/openclaw
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ── 10. SSL certificate via Let's Encrypt ─────────────────────────────────────
echo "==> Obtaining SSL certificate for $DOMAIN"
certbot --nginx \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  --redirect \
  -d "$DOMAIN" \
  -d "www.$DOMAIN"

systemctl reload nginx

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  OpenClaw is live!                                      ║"
echo "║  URL:   https://$DOMAIN                        ║"
echo "║  Token: $GATEWAY_TOKEN  ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Logs: docker compose -f $INSTALL_DIR/docker-compose.yml logs -f openclaw-gateway"
