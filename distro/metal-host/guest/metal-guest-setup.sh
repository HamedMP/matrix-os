#!/usr/bin/env bash
# S7 guest settings and the Matrix guest agent for metal golden disks.
# render-user-data.py embeds the unit files and the agent bundle (base64) and
# adds this script as a second cloud-init part beside the unchanged golden
# builder cloud-config; it runs before the builder's finalizer sanitizes the
# disk. Kernel arguments (memory hotplug, page reporting) come from the host's
# direct kernel boot, not from this disk.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

evidence=/var/lib/matrix-metal-guest/ready
log() { printf 'matrix-metal-guest: %s\n' "$*" >&2; }
apt_get() {
  timeout --kill-after=30 900 apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=20 "$@"
}
decode() {
  local data="$1" dest="$2" mode="$3"
  install -d -m 0755 "$(dirname "$dest")"
  printf '%s' "$data" | base64 -d >"$dest.tmp"
  chmod "$mode" "$dest.tmp"
  mv -f "$dest.tmp" "$dest"
}

rm -f "$evidence"
kernel="$(uname -r)"
apt_get update
# ptp_kvm ships in linux-modules-extra for the kernel the host boots.
apt_get install -y "linux-modules-extra-${kernel}" linuxptp socat
# Captured, not piped into grep -q: under pipefail an early grep exit can
# SIGPIPE socat and turn a match into a failure.
socat_help="$(socat -h 2>&1 || true)"
if ! grep -q 'max-children' <<<"$socat_help"; then
  log "installed socat does not support max-children"
  exit 1
fi

decode '@@GUEST_AGENT_B64@@' /opt/matrix/guest-agent/agent.mjs 0644
decode '@@GUEST_AGENT_UNIT_B64@@' /etc/systemd/system/matrix-guest-agent.service 0644
decode '@@GUEST_AGENT_VSOCK_UNIT_B64@@' /etc/systemd/system/matrix-guest-agent-vsock.service 0644
decode '@@PHC2SYS_UNIT_B64@@' /etc/systemd/system/phc2sys-kvm.service 0644

printf 'ptp_kvm\n' >/etc/modules-load.d/ptp_kvm.conf
modprobe ptp_kvm
# phc2sys owns the clock; a network time daemon would fight it after a restore.
for unit in systemd-timesyncd.service chrony.service; do
  if [ -n "$(systemctl list-unit-files "$unit" --no-legend)" ]; then
    systemctl disable --now "$unit"
  fi
done
systemctl daemon-reload
systemctl enable phc2sys-kvm.service matrix-guest-agent.service matrix-guest-agent-vsock.service
systemctl start phc2sys-kvm.service

install -d -m 0755 "$(dirname "$evidence")"
printf 'kernel=%s\nsocat_max_children=1\nptp_kvm=1\n' "$kernel" >"$evidence"
log "guest settings applied for kernel ${kernel}"
