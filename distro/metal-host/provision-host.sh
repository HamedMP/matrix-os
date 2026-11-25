#!/usr/bin/env bash
# Provision one bare-metal Matrix host for hostd (Ubuntu 24.04). Idempotent:
# every step checks before it changes anything, so re-running only repairs
# drift. It never flushes the nftables ruleset, never touches LVs it did not
# create, and never reloads another bridge; it is safe on a host that already
# runs other VMs (the S7 spike host). See docs/dev/metal-hosts.md.
#
# Usage: sudo distro/metal-host/provision-host.sh --host-name <fqdn> [options]
#   --wan-iface IF          public interface (default: the default-route interface)
#   --ingress-port N        owner ingress port (default 443)
#   --api-port N            host API port (default 8443)
#   --data-disks A,B        two whole disks whose free space becomes the RAID1
#                           PV for vmvg (a new "vmdata" partition on each);
#                           only used when vmvg does not exist yet
#   --confirm-firewall      keep a pending firewall change (run from a NEW SSH
#                           session): cancels the revert and enables the unit
#                           at boot; fails if the revert already happened
#   --snapshots-size SIZE   virtual size of the snapshot LV (default 400G)
#   --swap-size SIZE        host swap LV size (default 64G)
#   --hostd-bundle PATH     hostd bundle (default packages/hostd/dist/hostd/main.mjs)
#   --guest-agent PATH      guest agent bundle (default packages/hostd/dist/guest-agent/agent.mjs)
#
# hostd's nftables tables are the host firewall (see nftables.conf); SSH on
# the public interface is always accepted and checked before loading. Any
# firewall change (rules, helper, parameters, unit) is loaded unconfirmed by
# `matrix-hostd-nft arm`: the unit runs but is not enabled, a marker records
# when the window opened, and a 10-minute revert stops and disables it unless
# confirmed. After the window the unit refuses to load (fails open), so a
# reboot or restart can never bring back an unconfirmed firewall.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT

# Pinned artifacts. Cloud Hypervisor v54.1 static build (checksums from the
# GitHub release, verified on the S7 host), Ubuntu 24.04 cloud kernel, initrd
# and disk image (release-20261017), Node 24 for hostd.
readonly CH_VERSION=v54.1
readonly CH_URL="https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/v54.1/cloud-hypervisor-static"
readonly CH_SHA256=f9ffb9646783233d1f0fb09e77db1fca66499d1041e63bc011b90683c0d49933
readonly CH_REMOTE_URL="https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/v54.1/ch-remote-static"
readonly CH_REMOTE_SHA256=06c111b691ee085c0392e6d53f6600131e425e54669546dd0f2c40bdedc8e5ce
readonly UBUNTU_RELEASE="https://cloud-images.ubuntu.com/releases/noble/release-20261017"
readonly KERNEL_URL="$UBUNTU_RELEASE/unpacked/ubuntu-24.04-server-cloudimg-amd64-vmlinuz-generic"
readonly KERNEL_SHA256=41ba36d860aa0b0cd995f4ca8856d80249b244577e704929b55be13fbd1ebd2f
readonly INITRD_URL="$UBUNTU_RELEASE/unpacked/ubuntu-24.04-server-cloudimg-amd64-initrd-generic"
readonly INITRD_SHA256=bf276ffc12872256080890698b42db0dc9c5a469c896d8b59af6bc4e723cd186
readonly IMAGE_URL="$UBUNTU_RELEASE/ubuntu-24.04-server-cloudimg-amd64.img"
readonly IMAGE_SHA256=04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94
readonly NODE_VERSION=v24.22.0
readonly NODE_URL="https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz"
readonly NODE_SHA256=cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008
# Copies already on the S7 host; used instead of downloading when they match.
readonly LOCAL_ARTIFACT_DIRS="/opt/spike/bin /opt/spike/images"

readonly VG=vmvg
readonly POOL=pool
readonly SNAPSHOT_LV=hostd-snapshots
readonly SWAP_LV=hostd-swap
readonly BRIDGE=brmx
readonly BRIDGE_CIDR=10.78.0.1/22
readonly VM_USER=matrix-vm
readonly STATE_DIR=/var/lib/matrix-hostd
readonly ETC_DIR=/etc/matrix-hostd
readonly OPT_DIR=/opt/matrix-hostd

firewall_pending=0
host_name="" wan="" ingress_port=443 api_port=8443 data_disks=""
snapshots_size=400G swap_size=64G
hostd_bundle="$REPO_ROOT/packages/hostd/dist/hostd/main.mjs"
guest_agent="$REPO_ROOT/packages/hostd/dist/guest-agent/agent.mjs"

log() { printf 'provision-host: %s\n' "$*"; }
die() { printf 'provision-host: %s\n' "$*" >&2; exit 1; }
# Never `cmd | grep -q` under pipefail: grep exits at the first match, cmd can
# die of SIGPIPE, and the pipeline then reads as "no match". That once picked
# the wrong firewall mode and locked a host out.
has() { local pattern="$1" out; shift; out="$("$@" 2>/dev/null)" || true; grep -q -- "$pattern" <<<"$out"; }

if [ "${1:-}" = --confirm-firewall ]; then
  [ "$(id -u)" = 0 ] || die "run as root"
  # Fails (non-zero) when the revert already happened; see matrix-hostd-nft.
  exec /usr/local/libexec/matrix-hostd-nft confirm
fi
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || die "missing value for $1"
  case "$1" in
    --host-name) host_name="$2" ;;
    --wan-iface) wan="$2" ;;
    --ingress-port) ingress_port="$2" ;;
    --api-port) api_port="$2" ;;
    --data-disks) data_disks="$2" ;;
    --snapshots-size) snapshots_size="$2" ;;
    --swap-size) swap_size="$2" ;;
    --hostd-bundle) hostd_bundle="$2" ;;
    --guest-agent) guest_agent="$2" ;;
    *) die "unknown option $1" ;;
  esac
  shift 2
done

[ "$(id -u)" = 0 ] || die "run as root"
[[ "$host_name" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] || die "--host-name must be a lower-case FQDN"
for port in "$ingress_port" "$api_port"; do
  if ! [[ "$port" =~ ^[0-9]{1,5}$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then die "invalid port $port"; fi
done
[ "$ingress_port" != "$api_port" ] || die "ingress and API ports must differ"
[[ "$snapshots_size" =~ ^[0-9]+[GT]$ ]] || die "invalid --snapshots-size"
[[ "$swap_size" =~ ^[0-9]+G$ ]] || die "invalid --swap-size"
[ -f "$hostd_bundle" ] || die "hostd bundle missing (bun run --cwd packages/hostd build:hostd)"
[ -f "$guest_agent" ] || die "guest agent bundle missing (bun run --cwd packages/hostd build:guest-agent)"
if [ -z "$wan" ]; then
  wan="$(ip -o route show default | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')"
fi
if ! [[ "$wan" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || ! ip link show "$wan" >/dev/null 2>&1; then die "cannot use WAN interface '$wan'"; fi

# Old live VM units have neither per-tap identity rules nor bounded logs.
# Drain those units before changing the host network on an existing pilot.
policy_marker="$STATE_DIR/tenant-network-v1"
if [ ! -e "$policy_marker" ]; then
  live_guests="$(systemctl list-units --state=active,activating --no-legend --plain 'matrix-vm@*.service' 'matrix-vm-restore@*.service')"
  [ -z "$live_guests" ] || die "drain the existing Matrix VM units before enabling tenant isolation"
fi

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

# install_pinned <url> <sha256> <dest> <mode>: installs dest from a matching
# local copy or a verified download; leaves a matching dest alone.
install_pinned() {
  local url="$1" sha="$2" dest="$3" mode="$4" name candidate dir file
  if [ -f "$dest" ] && [ "$(sha256_of "$dest")" = "$sha" ]; then
    chmod "$mode" "$dest"
    return 0
  fi
  name="$(basename "$url")"
  candidate=""
  for dir in $LOCAL_ARTIFACT_DIRS; do
    for file in "$dir/$name" "$dir/${name%-static}" "$dir/${name/ubuntu-24.04-/noble-}"; do
      if [ -f "$file" ] && [ "$(sha256_of "$file")" = "$sha" ]; then candidate="$file"; break 2; fi
    done
  done
  if [ -z "$candidate" ]; then
    log "downloading $name"
    curl --fail --location --silent --show-error --retry 3 --connect-timeout 10 --max-time 900 -o "$work/$name" "$url"
    candidate="$work/$name"
  fi
  [ "$(sha256_of "$candidate")" = "$sha" ] || die "checksum mismatch for $name"
  install -d -m 0755 "$(dirname "$dest")"
  install -m "$mode" "$candidate" "$dest.new"
  mv -f "$dest.new" "$dest"
  log "installed $dest"
}

# install_file <src> <dest> <mode>: copies only when the content differs.
# Prints "changed" when it wrote the file.
install_file() {
  local src="$1" dest="$2" mode="$3"
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    chmod "$mode" "$dest"
    return 0
  fi
  install -d -m 0755 "$(dirname "$dest")"
  install -m "$mode" "$src" "$dest.new"
  mv -f "$dest.new" "$dest"
  echo changed
}

write_file() {
  local dest="$1" mode="$2"
  cat >"$work/content"
  install_file "$work/content" "$dest" "$mode"
}

# --- packages -----------------------------------------------------------------
missing_packages=()
for pkg in mdadm gdisk parted cloud-image-utils qemu-utils lvm2 thin-provisioning-tools python3-yaml openssl e2fsprogs iproute2 kmod nftables curl xz-utils; do
  # shellcheck disable=SC2016 # ${Status} is dpkg-query's format, not shell.
  has 'install ok installed' dpkg-query -W -f='${Status}' "$pkg" || missing_packages+=("$pkg")
done
if [ "${#missing_packages[@]}" -gt 0 ]; then
  log "installing packages: ${missing_packages[*]}"
  DEBIAN_FRONTEND=noninteractive timeout 900 apt-get update -qq
  DEBIAN_FRONTEND=noninteractive timeout 900 apt-get install -y -qq "${missing_packages[@]}"
fi

# The tap must fail closed if the running kernel lacks its packet filters.
for vm_filter in cls_flower act_gact act_police; do
  if ! modprobe "$vm_filter"; then
    DEBIAN_FRONTEND=noninteractive timeout 900 apt-get install -y -qq "linux-modules-extra-$(uname -r)"
    modprobe "$vm_filter" || die "running kernel lacks $vm_filter"
  fi
done
install_file "$SCRIPT_DIR/matrix-vm-network" /usr/local/libexec/matrix-vm-network 0755 >/dev/null
install_file "$SCRIPT_DIR/matrix-hostd-thin" /usr/local/libexec/matrix-hostd-thin 0755 >/dev/null

# --- VMM user -----------------------------------------------------------------
if ! id "$VM_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group "$VM_USER"
  log "created user $VM_USER"
fi
[[ " $(id -nG "$VM_USER") " == *" kvm "* ]] || usermod -aG kvm "$VM_USER"

# --- pinned binaries and images ------------------------------------------------
install_pinned "$CH_URL" "$CH_SHA256" /usr/local/bin/cloud-hypervisor 0755
install_pinned "$CH_REMOTE_URL" "$CH_REMOTE_SHA256" /usr/local/bin/ch-remote 0755
install_pinned "$KERNEL_URL" "$KERNEL_SHA256" "$STATE_DIR/kernel/vmlinuz" 0644
install_pinned "$INITRD_URL" "$INITRD_SHA256" "$STATE_DIR/kernel/initrd.img" 0644
install_pinned "$IMAGE_URL" "$IMAGE_SHA256" "$STATE_DIR/images/ubuntu-24.04-server-cloudimg-amd64.img" 0644

node_dir="$OPT_DIR/node-$NODE_VERSION"
if [ ! -x "$node_dir/bin/node" ] || [ "$("$node_dir/bin/node" --version)" != "$NODE_VERSION" ]; then
  log "installing Node $NODE_VERSION"
  curl --fail --location --silent --show-error --retry 3 --connect-timeout 10 --max-time 900 -o "$work/node.tar.xz" "$NODE_URL"
  [ "$(sha256_of "$work/node.tar.xz")" = "$NODE_SHA256" ] || die "checksum mismatch for Node"
  rm -rf -- "$node_dir.new"
  install -d -m 0755 "$node_dir.new"
  tar -xJf "$work/node.tar.xz" -C "$node_dir.new" --strip-components=1 --no-same-owner
  rm -rf -- "$node_dir"
  mv "$node_dir.new" "$node_dir"
fi
ln -sfn "node-$NODE_VERSION" "$OPT_DIR/node"

hostd_changed="$(install_file "$hostd_bundle" "$OPT_DIR/hostd.mjs" 0644)"
install_file "$guest_agent" "$OPT_DIR/guest-agent/agent.mjs" 0644 >/dev/null

# --- LVM: thin pool, snapshot filesystem, swap ---------------------------------
# The data RAID1: a "vmdata" partition (type FD00) in the free space of each
# disk, mirrored as /dev/md/vmdata, as the only PV of vmvg.
partition_named() {
  local disk="$1" part
  for part in $(lsblk -nrpo NAME "$disk" | tail -n +2); do
    if [ "$(lsblk -nro PARTLABEL "$part")" = vmdata ]; then printf '%s\n' "$part"; return 0; fi
  done
  return 1
}
if ! vgs "$VG" >/dev/null 2>&1; then
  [[ "$data_disks" =~ ^/dev/[a-z0-9]+,/dev/[a-z0-9]+$ ]] || die "VG $VG does not exist; pass --data-disks /dev/A,/dev/B"
  if [ ! -e /dev/md/vmdata ]; then
    parts=()
    for disk in ${data_disks/,/ }; do
      [ -b "$disk" ] || die "$disk is not a block device"
      if ! part="$(partition_named "$disk")"; then
        sgdisk --new=0:0:0 --typecode=0:FD00 --change-name=0:vmdata "$disk" >/dev/null
        partprobe "$disk"
        udevadm settle --timeout=10
        part="$(partition_named "$disk")" || die "could not create the vmdata partition on $disk"
      fi
      parts+=("$part")
    done
    mdadm --create /dev/md/vmdata --name=vmdata --level=1 --raid-devices=2 --metadata=1.2 --run "${parts[@]}"
    md_line="$(mdadm --detail --brief /dev/md/vmdata)"
    printf '%s\n' "$md_line" >>/etc/mdadm/mdadm.conf
    update-initramfs -u >/dev/null
    log "created RAID1 /dev/md/vmdata from ${parts[*]}"
  fi
  pvcreate /dev/md/vmdata
  vgcreate "$VG" /dev/md/vmdata
fi
if ! lvs "$VG/$POOL" >/dev/null 2>&1; then
  # Leave room outside the pool for the swap LV and pool metadata growth.
  lvcreate --type thin-pool --extents 95%FREE --name "$POOL" "$VG"
  log "created thin pool $VG/$POOL"
fi
[ "$(lvs --noheadings -o segtype "$VG/$POOL" | tr -d ' ')" = thin-pool ] || die "$VG/$POOL is not a thin pool"

install -d -m 0755 "$STATE_DIR"
if ! lvs "$VG/$SNAPSHOT_LV" >/dev/null 2>&1; then
  /usr/local/libexec/matrix-hostd-thin create "$VG" "$POOL" 85 80 "$SNAPSHOT_LV" "$snapshots_size"
  log "created $VG/$SNAPSHOT_LV ($snapshots_size)"
fi
/usr/local/libexec/matrix-hostd-thin check "$VG" "$POOL" 95 95 ||
  die "existing thin allocations exceed the physical pool budget; add storage or retire unused volumes"
if [ "$(blkid -o value -s TYPE "/dev/$VG/$SNAPSHOT_LV" 2>/dev/null || true)" != ext4 ]; then
  mkfs.ext4 -q -L hostd-snapshots -E lazy_itable_init=1,nodiscard "/dev/$VG/$SNAPSHOT_LV"
fi
install -d -m 0755 "$STATE_DIR/snapshots"
fstab_line="/dev/vmvg/hostd-snapshots /var/lib/matrix-hostd/snapshots ext4 defaults,noatime,discard,nofail 0 2"
grep -qF "$fstab_line" /etc/fstab || printf '%s\n' "$fstab_line" >>/etc/fstab
systemctl daemon-reload
has 'hostd--snapshots' findmnt -n --target "$STATE_DIR/snapshots" -o SOURCE || mount "$STATE_DIR/snapshots"
has 'hostd--snapshots' findmnt -n --target "$STATE_DIR/snapshots" -o SOURCE || die "snapshot LV is not mounted"
# The VMM (matrix-vm) writes and reads only inside snapshots/<id>, which hostd chowns.
chown root:"$VM_USER" "$STATE_DIR/snapshots"
chmod 0710 "$STATE_DIR/snapshots"

# Swap is a plain (thick) LV outside the thin pool: swapping into an
# overcommitted pool can deadlock exactly when memory is short.
if ! lvs "$VG/$SWAP_LV" >/dev/null 2>&1; then
  free_extents_g="$(vgs --noheadings --units g --nosuffix -o vg_free "$VG" | awk '{print int($1)}')"
  if [ "$free_extents_g" -ge "${swap_size%G}" ]; then
    lvcreate --yes --size "$swap_size" --name "$SWAP_LV" "$VG"
  else
    log "not enough free space in $VG for a $swap_size swap LV; skipping swap"
  fi
fi
if lvs "$VG/$SWAP_LV" >/dev/null 2>&1; then
  # Checked apart from the LV's existence: a run interrupted between lvcreate
  # and mkswap leaves the LV unformatted, and the retry finishes the job.
  swap_dev="/dev/$VG/$SWAP_LV"
  swap_type="$(blkid -p -s TYPE -o value "$swap_dev" 2>/dev/null || true)"
  case "$swap_type" in
    swap) ;;
    "")
      log "formatting $swap_dev as swap"
      mkswap -L hostd-swap "$swap_dev" >/dev/null
      ;;
    *) die "$swap_dev holds a $swap_type signature, not swap; inspect it before provisioning" ;;
  esac
  swap_line="/dev/vmvg/hostd-swap none swap sw,pri=10 0 0"
  grep -qF "$swap_line" /etc/fstab || printf '%s\n' "$swap_line" >>/etc/fstab
  has "$(readlink -f "/dev/$VG/$SWAP_LV")" swapon --show=NAME --noheadings || swapon --priority 10 "/dev/$VG/$SWAP_LV"
fi
write_file /etc/tmpfiles.d/matrix-hostd-zswap.conf 0644 >/dev/null <<'EOF'
# Compressed swap cache in front of the swap LV (matrix-hostd provisioning).
w- /sys/module/zswap/parameters/compressor - - - - zstd
w- /sys/module/zswap/parameters/max_pool_percent - - - - 20
w- /sys/module/zswap/parameters/enabled - - - - Y
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/matrix-hostd-zswap.conf
write_file /etc/sysctl.d/60-matrix-hostd.conf 0644 >/dev/null <<'EOF'
net.ipv4.ip_forward = 1
vm.swappiness = 10
EOF
sysctl -q -p /etc/sysctl.d/60-matrix-hostd.conf

# --- device access for the unprivileged VMM ------------------------------------
# /dev/userfaultfd lets matrix-vm run ondemand restores without making
# userfaultfd available to every user (vm.unprivileged_userfaultfd stays 0).
# VM disks (vmvg/mx-vm_*) belong to matrix-vm; the golden, snapshot and swap
# LVs do not match and keep their default owner.
udev_changed="$(write_file /etc/udev/rules.d/60-matrix-hostd.rules 0644 <<'EOF'
KERNEL=="userfaultfd", GROUP="matrix-vm", MODE="0660"
SUBSYSTEM=="block", ENV{DM_VG_NAME}=="vmvg", ENV{DM_LV_NAME}=="mx-vm_*", OWNER="matrix-vm", GROUP="matrix-vm", MODE="0660"
EOF
)"
if [ -n "$udev_changed" ] || [ "$(stat -c %G /dev/userfaultfd)" != "$VM_USER" ]; then
  udevadm control --reload
  udevadm trigger --action=change --sysname-match=userfaultfd
  udevadm settle --timeout=10
fi
[ "$(stat -c %G:%a /dev/userfaultfd)" = "$VM_USER:660" ] || die "/dev/userfaultfd is not group $VM_USER"

# --- VM bridge -----------------------------------------------------------------
bridge_changed="$(write_file /etc/systemd/network/21-brmx.netdev 0644 <<EOF
[NetDev]
Name=$BRIDGE
Kind=bridge

[Bridge]
STP=no
EOF
)"
bridge_changed+="$(write_file /etc/systemd/network/21-brmx.network 0644 <<EOF
[Match]
Name=$BRIDGE

[Network]
Address=$BRIDGE_CIDR
ConfigureWithoutCarrier=yes
LinkLocalAddressing=no
IPv6AcceptRA=no

[Link]
RequiredForOnline=no
EOF
)"
if [ -n "$bridge_changed" ] || ! has "${BRIDGE_CIDR%/*}/" ip -4 addr show dev "$BRIDGE"; then
  networkctl reload
  for _ in $(seq 1 50); do
    has "${BRIDGE_CIDR%/*}/" ip -4 addr show dev "$BRIDGE" && break
    sleep 0.2
  done
fi
has "${BRIDGE_CIDR%/*}/" ip -4 addr show dev "$BRIDGE" || die "bridge $BRIDGE did not come up"

# --- firewall --------------------------------------------------------------------
# Dry run first: render with these exact parameters, require SSH on the
# public interface to be accepted, and let nft parse it, before anything loads.
# Uses the new helper and template from this checkout; nothing is installed yet.
bash "$SCRIPT_DIR/matrix-hostd-nft" render --template "$SCRIPT_DIR/nftables.conf" \
  --wan "$wan" --ingress-port "$ingress_port" --api-port "$api_port" >"$work/nftables.nft"
bash "$SCRIPT_DIR/matrix-hostd-nft" check "$work/nftables.nft" --wan "$wan"
nft -c -f "$work/nftables.nft"
bash "$SCRIPT_DIR/matrix-hostd-nft" render --template "$SCRIPT_DIR/nftables-tenant.conf" \
  --wan "$wan" --ingress-port "$ingress_port" --api-port "$api_port" >"$work/tenant.nft"
nft -c -f "$work/tenant.nft"
log "firewall dry run: ruleset parses and accepts SSH on $wan"
# Installed only here, just before the decision to arm. A run that dies after
# this point still cannot load them: outside an open window the unit loads only
# rules matching the confirmed fingerprint, and the retry sees the difference.
install_file "$SCRIPT_DIR/matrix-hostd-nft" /usr/local/libexec/matrix-hostd-nft 0755 >/dev/null
install_file "$SCRIPT_DIR/nftables.conf" /usr/local/share/matrix-hostd/nftables.conf 0644 >/dev/null
install_file "$SCRIPT_DIR/nftables-tenant.conf" /usr/local/share/matrix-hostd/nftables-tenant.conf 0644 >/dev/null
install -d -m 0755 "$ETC_DIR"
write_file "$ETC_DIR/nft.env" 0644 >/dev/null <<EOF
WAN=$wan
INGRESS_PORT=$ingress_port
API_PORT=$api_port
EOF
# The firewall changed when what would load differs from the last confirmed
# rules and helper (or nothing was ever confirmed).
nft_changed=""
if /usr/local/libexec/matrix-hostd-nft changed; then nft_changed=changed; fi

# --- hostd configuration ---------------------------------------------------------
install -d -m 0700 "$ETC_DIR/tls"
if [ ! -f "$ETC_DIR/tls/key.pem" ] || ! openssl x509 -in "$ETC_DIR/tls/cert.pem" -noout -checkend 604800 >/dev/null 2>&1; then
  # Self-signed for the smoke; production installs a real certificate here.
  openssl req -x509 -newkey rsa:3072 -nodes -days 90 -subj "/CN=$host_name" \
    -addext "subjectAltName=DNS:$host_name,DNS:*.matrix-os.com" \
    -keyout "$ETC_DIR/tls/key.pem.new" -out "$ETC_DIR/tls/cert.pem.new" 2>/dev/null
  chmod 0600 "$ETC_DIR/tls/key.pem.new"
  mv -f "$ETC_DIR/tls/key.pem.new" "$ETC_DIR/tls/key.pem"
  mv -f "$ETC_DIR/tls/cert.pem.new" "$ETC_DIR/tls/cert.pem"
  hostd_changed=changed
fi
env_file="$ETC_DIR/hostd.env"
if [ ! -f "$env_file" ]; then
  umask 077
  {
    printf 'HOSTD_API_TOKEN=%s\n' "$(openssl rand -hex 32)"
    printf 'HOSTD_INGRESS_TOKEN=%s\n' "$(openssl rand -hex 32)"
  } >"$env_file.new"
  mv -f "$env_file.new" "$env_file"
  umask 022
  hostd_changed=changed
fi
chmod 0600 "$env_file"
set_env() {
  local key="$1" value="$2"
  if grep -q "^$key=" "$env_file"; then
    if [ "$(sed -n "s/^$key=//p" "$env_file")" != "$value" ]; then
      sed -i "s|^$key=.*|$key=$value|" "$env_file"
      hostd_changed=changed
    fi
  else
    printf '%s=%s\n' "$key" "$value" >>"$env_file"
    hostd_changed=changed
  fi
}
set_env HOSTD_TLS_CERT_PATH "$ETC_DIR/tls/cert.pem"
set_env HOSTD_TLS_KEY_PATH "$ETC_DIR/tls/key.pem"
set_env HOSTD_API_PORT "$api_port"
set_env HOSTD_INGRESS_PORT "$ingress_port"
set_env HOSTD_STATE_DIR "$STATE_DIR"
set_env HOSTD_RUN_DIR /run/matrix-vm

install -d -m 0750 -o root -g "$VM_USER" "$STATE_DIR/vms"
journal_changed="$(install_file "$SCRIPT_DIR/journald-matrix-vm.conf" /etc/systemd/journald@matrix-vm.conf.d/60-limits.conf 0644)"
if [ -n "$journal_changed" ] && systemctl is-active --quiet systemd-journald@matrix-vm.service; then
  systemctl restart systemd-journald@matrix-vm.service
fi
install -d -m 0750 -o "$VM_USER" -g "$VM_USER" /var/log/matrix-vm
install -d -m 0700 "$STATE_DIR/golden"

# --- units -------------------------------------------------------------------------
units_changed=""
for unit in matrix-vm@.service matrix-vm-restore@.service matrix-hostd.service matrix-hostd-nft.service matrix-hostd-tenant-nft.service; do
  units_changed+="$(install_file "$SCRIPT_DIR/systemd/$unit" "/etc/systemd/system/$unit" 0644)"
done
systemctl daemon-reload
# Install mandatory isolation before touching the revertible public firewall.
systemctl enable --quiet matrix-hostd-tenant-nft.service
systemctl reload-or-restart matrix-hostd-tenant-nft.service
# The public firewall unit is enabled only by `--confirm-firewall`.
systemctl enable --quiet matrix-hostd.service
if [ -n "$nft_changed$units_changed" ] || ! systemctl is-active --quiet matrix-hostd-nft.service; then
  # Dead-man switch: unenabled, marker written, undone in 10 minutes unless
  # confirmed from a new session; a stale marker keeps it off after a reboot.
  /usr/local/libexec/matrix-hostd-nft arm
  firewall_pending=1
else
  systemctl reload matrix-hostd-nft.service
fi
if [ -n "$hostd_changed$units_changed" ] || ! systemctl is-active --quiet matrix-hostd.service; then
  systemctl restart matrix-hostd.service
fi
for _ in $(seq 1 50); do
  has LISTEN ss -ltn "sport = :$api_port" && break
  sleep 0.2
done
has LISTEN ss -ltn "sport = :$api_port" || die "hostd is not listening on $api_port (journalctl -u matrix-hostd)"

install -m 0644 /dev/null "$policy_marker"
log "host $host_name ready: hostd API :$api_port, ingress :$ingress_port, bridge $BRIDGE, Cloud Hypervisor $CH_VERSION"
if [ "$firewall_pending" = 1 ]; then
  log "firewall changed: open a NEW SSH session and run 'sudo $0 --confirm-firewall' within 10 minutes, or it is reverted"
fi
