#!/bin/bash
# Supply the dedicated CI PUBLIC ed25519 key on stdin; no private key on host.
set -euo pipefail
set +x
[[ $EUID == 0 ]] || { echo 'Requires root' >&2; exit 64; }
read -r public_key
[[ ${#public_key} -le 512 && $public_key =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9_.@-]+)?$ ]] || { echo 'Invalid dedicated public key' >&2; exit 64; }
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
apt-get install -y sudo
id matrixci >/dev/null 2>&1 || useradd --create-home --shell /bin/bash matrixci
install -d -o root -g root -m 0755 /usr/local/libexec/matrix-ci
for script in start-ephemeral.sh dispatch.sh cleanup-host.sh; do
  install -o root -g root -m 0755 "$script_dir/$script" "/usr/local/libexec/matrix-ci/$script"
done
install -d -o root -g root -m 0755 /etc/ssh/matrix-ci
printf 'restrict,command="/usr/local/libexec/matrix-ci/dispatch.sh" %s\n' "$public_key" >/etc/ssh/matrix-ci/authorized_keys
chmod 0644 /etc/ssh/matrix-ci/authorized_keys
cat >/etc/sudoers.d/matrix-ci <<'SUDOERS'
Defaults:matrixci env_reset,secure_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
matrixci ALL=(root) NOPASSWD: /usr/local/libexec/matrix-ci/start-ephemeral.sh *
SUDOERS
chmod 0440 /etc/sudoers.d/matrix-ci
visudo -cf /etc/sudoers.d/matrix-ci
cat >/etc/ssh/sshd_config.d/70-matrix-ci-dispatch.conf <<'SSH'
Match User matrixci
    AuthorizedKeysFile /etc/ssh/matrix-ci/authorized_keys
    ForceCommand /usr/local/libexec/matrix-ci/dispatch.sh
    PermitTTY no
    AllowTcpForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTunnel no
    PermitUserEnvironment no
Match all
SSH
sshd -t
systemctl reload ssh
echo 'Installed forced-command SSH admission: run <sha> <suite>'
