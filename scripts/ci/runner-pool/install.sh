#!/usr/bin/env bash
# Installs or updates the runner pool on the dedicated CI host. Run as root from a checkout of main:
#   sudo bash scripts/ci/runner-pool/install.sh
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }
source_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
config=/etc/matrix-ci-pool/pool.env

for tool in docker jq openssl curl systemctl iptables; do
  command -v "$tool" >/dev/null || { echo "Missing $tool." >&2; exit 1; }
done

install -d -m 0755 /opt/matrix-ci-pool
install -m 0755 "$source_dir/pool.sh" "$source_dir/firewall.sh" /opt/matrix-ci-pool/
install -m 0644 "$source_dir/matrix-ci-pool-slot@.service" "$source_dir/matrix-ci-pool-heartbeat.service" \
  "$source_dir/matrix-ci-pool-firewall.service" /etc/systemd/system/

install -d -m 0700 /etc/matrix-ci-pool
if [ ! -f "$config" ]; then
  install -m 0600 "$source_dir/pool.env.example" "$config"
  echo "Created $config with the CI gate app IDs. Review slot sizing, place the app key at APP_KEY_FILE, then rerun." >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$config"
: "${APP_ID:?APP_ID is empty in $config}" "${INSTALLATION_ID:?INSTALLATION_ID is empty in $config}"
key=${APP_KEY_FILE:-/etc/matrix-ci-pool/app.pem}
[ -f "$key" ] || { echo "Missing GitHub App key $key." >&2; exit 1; }
chown root:root "$config" "$key" && chmod 0600 "$config" && chmod 0400 "$key"

slots=${SLOTS:-4} slot_cpus=${SLOT_CPUS:-8}
if (( slots * slot_cpus > $(nproc) )); then
  echo "SLOTS * SLOT_CPUS ($((slots * slot_cpus))) exceeds $(nproc) CPUs." >&2
  exit 1
fi

docker build --pull -t "${IMAGE:-matrix-ci-runner:current}" "$source_dir"

docker network inspect matrix-ci-pool >/dev/null 2>&1 || docker network create --driver bridge \
  --subnet 172.30.81.0/24 --opt com.docker.network.bridge.name=matrix-ci-pool0 matrix-ci-pool

systemctl daemon-reload
systemctl enable matrix-ci-pool-firewall.service
systemctl restart matrix-ci-pool-firewall.service
# Stop slots beyond the configured count, then (re)start the configured ones.
for unit in $(systemctl list-units 'matrix-ci-pool-slot@*' --all --no-legend --plain | awk '{print $1}'); do
  index=${unit#matrix-ci-pool-slot@}; index=${index%.service}
  if (( index > slots )); then systemctl disable --now "$unit"; fi
done
for index in $(seq 1 "$slots"); do systemctl enable "matrix-ci-pool-slot@$index.service"; done
for index in $(seq 1 "$slots"); do systemctl restart "matrix-ci-pool-slot@$index.service"; done
systemctl enable matrix-ci-pool-heartbeat.service
systemctl restart matrix-ci-pool-heartbeat.service
echo "Runner pool running with $slots slots of $slot_cpus CPUs."
