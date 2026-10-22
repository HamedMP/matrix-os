#!/usr/bin/env bash
set -euo pipefail
# Owner-only installed preview upgrade: never stop/reinstall the signed-in browser.
LAB_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_PREFIX=/opt/matrix-browser-lab
if [ "$(id -u)" != 0 ] || { [ $# != 1 ] && [ $# != 3 ]; }; then
  echo 'Usage: sudo ./update-experience.sh preview [machine-id owner-id]' >&2
  exit 64
fi
/usr/bin/python3 -I "$LAB_SOURCE/native-experience.py" guard "$@"
test -f "$LAB_PREFIX/app/supervisor.mjs"
test -f "$LAB_SOURCE/lab/dist/index.html"
test -f "$LAB_SOURCE/native-windows.mjs"
getent passwd matrix >/dev/null
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends wmctrl thunar xfce4-terminal xfdesktop4 tint2
tar -C "$LAB_SOURCE" --exclude=node_modules --exclude=.venv --exclude=__pycache__ -cf - . | tar -C "$LAB_PREFIX/app" -xf -
chown -R root:root "$LAB_PREFIX/app"
chmod 0755 "$LAB_PREFIX/app"
/usr/bin/python3 -I "$LAB_SOURCE/native-experience.py" install "$@"
cp -a "$LAB_SOURCE/lab/dist/." /home/matrix/home/apps/browser-lab/
cp "$LAB_SOURCE/lab/matrix.json" /home/matrix/home/apps/browser-lab/
chown -R matrix:matrix /home/matrix/home/apps/browser-lab
systemctl daemon-reload
systemctl enable --now matrix-browser-lab-desktop.service matrix-browser-lab-panel.service
systemctl restart matrix-browser-lab.service
echo 'Native experience updated. Existing browser and display processes were preserved.'
