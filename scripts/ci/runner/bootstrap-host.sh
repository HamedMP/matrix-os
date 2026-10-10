#!/bin/bash
# Run as root on a new dedicated Ubuntu 24.04 x86-64 host via existing SSH key.
# No production credentials, GitHub PAT, or cloud API key belongs on this host.
set -euo pipefail
[[ $EUID == 0 && $(uname -m) == x86_64 ]] || { echo 'Requires root on dedicated x86-64 host' >&2; exit 64; }
apt-get update
apt-get install -y docker.io iptables ufw util-linux ca-certificates
systemctl enable --now docker
install -d -m 0700 /var/lib/matrix-ci/results
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' >/etc/ssh/sshd_config.d/60-matrix-ci.conf
sshd -t
systemctl reload ssh
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw --force enable
docker network inspect matrix-ci >/dev/null 2>&1 || docker network create --driver bridge --subnet 172.30.80.0/24 --opt com.docker.network.bridge.name=matrix-ci0 matrix-ci
cat >/usr/local/sbin/matrix-ci-firewall <<'FIREWALL'
#!/bin/bash
set -euo pipefail
iptables -N MATRIX-CI-EGRESS 2>/dev/null || true
iptables -F MATRIX-CI-EGRESS
# Return traffic is permitted; new requests can reach only public IPv4 hosts.
iptables -A MATRIX-CI-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  iptables -A MATRIX-CI-EGRESS -d "$cidr" -j REJECT
done
iptables -A MATRIX-CI-EGRESS -j RETURN
iptables -C DOCKER-USER -i matrix-ci0 -j MATRIX-CI-EGRESS 2>/dev/null || iptables -I DOCKER-USER 1 -i matrix-ci0 -j MATRIX-CI-EGRESS
# Docker bridge -> host traffic is INPUT, not DOCKER-USER. Reject all new host
# access, including services listening on the host's public IP.
iptables -C INPUT -i matrix-ci0 -j REJECT 2>/dev/null || iptables -I INPUT 1 -i matrix-ci0 -j REJECT
FIREWALL
chmod 0755 /usr/local/sbin/matrix-ci-firewall
cat >/etc/systemd/system/matrix-ci-firewall.service <<'SERVICE'
[Unit]
Description=Block CI container access to host and private networks
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/matrix-ci-firewall
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable --now matrix-ci-firewall
echo 'Build image from the reviewed scripts/ci/runner directory, then run start-ephemeral.sh.'
