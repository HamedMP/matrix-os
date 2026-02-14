#!/usr/bin/env bash
set -euo pipefail

echo "=== Matrix OS Server Setup ==="

# Node.js 22
if ! command -v node &>/dev/null || [[ "$(node -v)" != v22* ]]; then
  echo "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# pnpm
if ! command -v pnpm &>/dev/null; then
  echo "Installing pnpm..."
  corepack enable
  corepack prepare pnpm@latest --activate
fi

# git
apt-get install -y git

# Create user
if ! id matrixos &>/dev/null; then
  useradd -m -s /bin/bash matrixos
fi

# Clone or update
if [ ! -d /opt/matrixos ]; then
  echo "Cloning Matrix OS..."
  git clone https://github.com/user/matrix-os.git /opt/matrixos
  chown -R matrixos:matrixos /opt/matrixos
else
  echo "Updating Matrix OS..."
  cd /opt/matrixos && git pull
fi

# Install deps + build
cd /opt/matrixos
sudo -u matrixos pnpm install --frozen-lockfile

# Config
mkdir -p /etc/matrixos
if [ ! -f /etc/matrixos/env ]; then
  cat > /etc/matrixos/env <<'ENVEOF'
ANTHROPIC_API_KEY=
MATRIX_AUTH_TOKEN=
MATRIX_HOME=/home/matrixos/matrixos
PORT=4000
ENVEOF
  echo "Edit /etc/matrixos/env to set your API key and auth token"
fi

# Systemd
cp /opt/matrixos/scripts/matrixos.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable matrixos

echo ""
echo "=== Setup Complete ==="
echo "1. Edit /etc/matrixos/env with your ANTHROPIC_API_KEY"
echo "2. Start: systemctl start matrixos"
echo "3. Check: journalctl -u matrixos -f"
