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
# Functional check (H3): socat must accept max-children, which the vsock
# bridge unit uses. `socat -h` does not list it (only -hh does), so start a
# listener with the option: an unknown option exits at once with an error,
# an accepted one keeps listening until timeout ends it (status 124).
probe_dir="$(mktemp -d)"
set +e
timeout 1 socat "UNIX-LISTEN:${probe_dir}/probe.sock,fork,max-children=8" /dev/null 2>/dev/null
probe_status=$?
set -e
rm -rf -- "$probe_dir"
if [ "$probe_status" != 124 ]; then
  log "installed socat does not accept max-children"
  exit 1
fi

decode '@@GUEST_AGENT_B64@@' /opt/matrix/guest-agent/agent.mjs 0644
decode '@@GUEST_AGENT_UNIT_B64@@' /etc/systemd/system/matrix-guest-agent.service 0644
decode '@@GUEST_AGENT_VSOCK_UNIT_B64@@' /etc/systemd/system/matrix-guest-agent-vsock.service 0644
decode '@@PHC2SYS_UNIT_B64@@' /etc/systemd/system/phc2sys-kvm.service 0644

# Ubuntu 24.04 starts sshd by socket activation, so /run/sshd does not exist
# until the first connection. The customer cloud-init validates the sshd
# config (matrix-support-access install runs sshd -t) before anything has
# connected, and sshd -t fails without that directory. Create it at boot.
printf 'd /run/sshd 0755 root root -\n' >/etc/tmpfiles.d/matrix-sshd-privsep.conf

# hostd clones this disk and lvextends the clone to the VM's disk size, so
# every boot must grow the root partition and filesystem into the new space.
# Ubuntu enables both by default; pin them so an image change cannot drop it.
install -d -m 0755 /etc/cloud/cloud.cfg.d
cat >/etc/cloud/cloud.cfg.d/90-matrix-grow-root.cfg <<'CFG'
growpart:
  mode: auto
  devices: ['/']
resize_rootfs: true
CFG

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
