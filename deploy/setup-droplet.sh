#!/usr/bin/env bash
# Phase 1: Prepare the droplet for OpenClaw (non-interactive).
# After this script finishes, run docker-setup.sh interactively for onboarding.
# Then run deploy/post-onboard.sh to set up nginx + SSL.
#
# Usage: bash /home/openclaw/deploy/setup-droplet.sh
set -euo pipefail

REPO_URL="https://github.com/imzodev/openclaw-plus.git"
BRANCH="stable-custom"
INSTALL_DIR="/home/openclaw"
OPENCLAW_CONFIG_DIR="/root/.openclaw"

# ── 1. System update + packages ──────────────────────────────────────────────
echo "==> Updating system and installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq ca-certificates curl gnupg git

# ── 2. Swap (prevents OOM during Docker build on 2GB droplet) ────────────────
if ! swapon --show | grep -q '/swapfile'; then
  echo "==> Creating 2GB swap file"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "==> Swap enabled"
else
  echo "==> Swap already configured"
fi

# ── 3. Docker ────────────────────────────────────────────────────────────────
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

# ── 4. Clone / update repo ───────────────────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "==> Updating repo"
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --rebase origin "$BRANCH"
else
  echo "==> Cloning repo (branch: $BRANCH)"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

# ── 5. Pre-create config dir with correct ownership (avoids permission error) -
echo "==> Creating config directory"
mkdir -p "$OPENCLAW_CONFIG_DIR"
chown -R 1000:1000 "$OPENCLAW_CONFIG_DIR"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Phase 1 complete! Now run the interactive onboarding:      ║"
echo "║                                                              ║"
echo "║    cd $INSTALL_DIR                               ║"
echo "║    ./docker-setup.sh                                         ║"
echo "║                                                              ║"
echo "║  During onboarding choose:                                   ║"
echo "║    Gateway bind -> lan                                       ║"
echo "║    Gateway auth -> Token                                     ║"
echo "║    Configure channels -> No                                  ║"
echo "║                                                              ║"
echo "║  After onboarding, run:                                      ║"
echo "║    bash $INSTALL_DIR/deploy/post-onboard.sh      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
