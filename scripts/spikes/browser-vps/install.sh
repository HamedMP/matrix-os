#!/usr/bin/env bash
set -euo pipefail
# Test host only. Private previews additionally require their machine and owner IDs.
LAB_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_PREFIX=/opt/matrix-browser-lab
LAB_NODE=/opt/matrix/runtime/node/bin/node
if [ "$(id -u)" != 0 ] || { [ $# != 1 ] && [ $# != 3 ]; }; then
  echo 'Usage: sudo ./install.sh preview [machine-id owner-id]' >&2
  exit 64
fi
/usr/bin/python3 -I "$LAB_SOURCE/native-experience.py" guard "$@"
. /etc/os-release
if [ "$ID" != ubuntu ] || [ "$VERSION_ID" != 24.04 ] || [ "$(uname -m)" != x86_64 ]; then
  echo 'This pinned lab installer requires Ubuntu 24.04 x86_64' >&2
  exit 64
fi
getent passwd matrix >/dev/null
test -d "$LAB_SOURCE/lab/dist"
test -f "$LAB_SOURCE/supervisor.mjs"
# Full-browser WS is scoped to this test app. Ordinary /apps/ proxy lacks upgrades.
"$LAB_NODE" "$LAB_SOURCE/nginx-viewer.mjs"
nginx -t
systemctl reload nginx
install -d -m 0755 "$LAB_PREFIX/app" "$LAB_PREFIX/bin"
LAB_TEMP="$(mktemp -d /tmp/matrix-browser-install.XXXXXX)"
trap 'rm -rf -- "$LAB_TEMP"' EXIT
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends openbox dbus-x11 xauth x11-utils xfonts-base fonts-liberation libnss3 libsecret-1-0 ca-certificates curl python3-venv unzip wmctrl thunar xfce4-terminal xfdesktop4 tint2
curl --fail --location --max-time 180 https://github.com/kasmtech/KasmVNC/releases/download/v1.5.0/kasmvncserver_noble_1.5.0_amd64.deb -o "$LAB_TEMP/kasm.deb"
printf 'f599fe02e2175b9817b6165f74a5d2bebdc73118dde9181ba3410963bed7ae1e  %s\n' "$LAB_TEMP/kasm.deb" | sha256sum -c -
apt-get install -y "$LAB_TEMP/kasm.deb"
curl --fail --location --max-time 180 https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "$LAB_TEMP/chrome.deb"
apt-get install -y "$LAB_TEMP/chrome.deb"
curl --fail --location --max-time 180 https://github.com/vercel-labs/agent-browser/releases/download/v0.39.0/agent-browser-linux-x64 -o "$LAB_TEMP/agent-browser"
printf 'd258593db4899577748a4b2a671a315f76f07a4553ba7fbbeaa95f0d16a4aaa8  %s\n' "$LAB_TEMP/agent-browser" | sha256sum -c -
install -m 0755 "$LAB_TEMP/agent-browser" "$LAB_PREFIX/bin/agent-browser"
python3 -m venv "$LAB_PREFIX/venv"
"$LAB_PREFIX/venv/bin/pip" install --disable-pip-version-check 'browser-use==0.13.11'
# Executables remain root-owned; browser/worker profiles belong to the VPS owner.
tar -C "$LAB_SOURCE" --exclude=node_modules --exclude=.venv -cf - . | tar -C "$LAB_PREFIX/app" -xf -
chown -R root:root "$LAB_PREFIX/app" "$LAB_PREFIX/bin" "$LAB_PREFIX/venv"
chmod 0755 "$LAB_PREFIX/app"
install -d -o matrix -g matrix -m 0700 /home/matrix/.local/share/matrix-browser-lab/chrome
install -d -m 0755 /etc/opt/chrome/policies/managed
cat > /etc/opt/chrome/policies/managed/matrix-browser-lab.json <<'JSON'
{"ExtensionInstallForcelist":["aeblfdkhhhdcdjpifhhbdiojplfjncoa;https://clients2.google.com/service/update2/crx"],"BrowserSignin":0,"PasswordManagerEnabled":false}
JSON
# Random stream credential stays server-side; arbitrary pages in Chrome cannot
# connect directly to the loopback desktop viewer without authentication.
# A retry after service installation failed must retain the existing viewer
# credential pair, just as it retains the Chrome profile.
if [ ! -f "$LAB_PREFIX/viewer.passwd" ] || ! grep -Eq '^MATRIX_BROWSER_LAB_VIEWER_AUTH="?Basic [A-Za-z0-9+/]+={0,2}"?$' /opt/matrix/env/host.env; then
python3 - <<'AUTH'
import base64, os, secrets, subprocess
from pathlib import Path
password = secrets.token_hex(32)
passwd = '/opt/matrix-browser-lab/viewer.passwd'
subprocess.run(['/usr/bin/kasmvncpasswd', '-u', 'matrix-browser-lab', '-r', '-w', passwd],
    input=f'{password}\n{password}\n', text=True, check=True, capture_output=True, timeout=10)
import grp
os.chown(passwd, 0, grp.getgrnam('matrix').gr_gid)
os.chmod(passwd, 0o640)
auth = 'Basic ' + base64.b64encode(f'matrix-browser-lab:{password}'.encode()).decode()
subprocess.run(['/opt/matrix/runtime/node/bin/node', '/opt/matrix-browser-lab/app/viewer-auth.mjs'],
    input=auth, text=True, check=True, capture_output=True, timeout=10)
AUTH
fi
cat > /etc/systemd/system/matrix-browser-lab-vnc.service <<'UNIT'
[Unit]
Description=Matrix test browser full-window viewer (loopback only)
After=network.target
[Service]
User=matrix
Group=matrix
ExecStart=/usr/bin/Xvnc :7 -interface 127.0.0.1 -websocketPort 6901 -sslOnly 0 -AllowOverride AcceptPointerEvents,AcceptKeyEvents -KasmPasswordFile /opt/matrix-browser-lab/viewer.passwd -SecurityTypes None -httpd /usr/share/kasmvnc/www -geometry 1440x900 -depth 24 -nolisten tcp
Restart=on-failure
RestartSec=3
MemoryMax=1G
TasksMax=128
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/matrix-browser-lab-wm.service <<'UNIT'
[Unit]
Description=Matrix test browser window manager
Requires=matrix-browser-lab-vnc.service
After=matrix-browser-lab-vnc.service
[Service]
User=matrix
Group=matrix
Environment=DISPLAY=:7
ExecStart=/usr/bin/openbox --sm-disable
Restart=on-failure
RestartSec=3
MemoryMax=256M
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
UNIT
/usr/bin/python3 -I "$LAB_SOURCE/native-experience.py" install "$@"
cat > /etc/systemd/system/matrix-browser-lab.service <<'UNIT'
[Unit]
Description=Matrix test browser automation supervisor
After=matrix-browser-lab-chrome.service
[Service]
User=matrix
Group=matrix
WorkingDirectory=/opt/matrix-browser-lab/app
Environment=DISPLAY=:7
Environment=BROWSER_LAB_STATIC_DIR=/opt/matrix-browser-lab/app/lab/dist
Environment=AGENT_BROWSER_EXECUTABLE=/opt/matrix-browser-lab/bin/agent-browser
Environment=BROWSER_USE_PYTHON=/opt/matrix-browser-lab/venv/bin/python
Environment=ANONYMIZED_TELEMETRY=false
Environment=BROWSER_USE_ANONYMIZED_TELEMETRY=false
Environment=BROWSER_USE_LOGGING_LEVEL=critical
ExecStart=/opt/matrix/runtime/node/bin/node /opt/matrix-browser-lab/app/supervisor.mjs
Restart=on-failure
RestartSec=3
KillMode=control-group
MemoryMax=1G
TasksMax=128
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
UNIT
# Keep installation confined to this test owner's app directory.
install -d -o matrix -g matrix -m 0755 /home/matrix/home/apps/browser-lab
cp -a "$LAB_SOURCE/lab/dist/." /home/matrix/home/apps/browser-lab/
cp "$LAB_SOURCE/lab/matrix.json" /home/matrix/home/apps/browser-lab/
chown -R matrix:matrix /home/matrix/home/apps/browser-lab
if ! grep -q '^MATRIX_BROWSER_LAB=' /opt/matrix/env/host.env; then
  printf '\nMATRIX_BROWSER_LAB=true\n' >> /opt/matrix/env/host.env
elif ! grep -q '^MATRIX_BROWSER_LAB=true$' /opt/matrix/env/host.env; then
  echo 'Lab environment is already configured differently; refusing overwrite' >&2
  exit 1
fi
systemctl daemon-reload
systemctl enable --now matrix-browser-lab-vnc matrix-browser-lab-wm matrix-browser-lab-desktop matrix-browser-lab-panel matrix-browser-lab-chrome matrix-browser-lab
systemctl restart matrix-gateway
"$LAB_PREFIX/bin/agent-browser" --version
google-chrome-stable --version
echo 'Browser lab installed; all viewer, automation and CDP services must listen only on loopback.'
