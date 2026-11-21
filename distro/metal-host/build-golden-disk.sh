#!/usr/bin/env bash
# Build the read-only golden disk vmvg/golden-<bundle-version> that hostd
# clones for every new VM. Boots a builder VM from the pinned Ubuntu cloud
# image with the unchanged golden builder cloud-init
# (distro/customer-vps/golden-snapshot-builder-cloud-init.yaml: installs and
# activates the host bundle, runs matrix-golden-snapshot-sanitize, powers off)
# plus the S7 guest settings and the guest agent (guest/metal-guest-setup.sh).
# Then boots a throwaway clone to validate the result and only then renames
# the LV to its final name and makes it read-only. Idempotent: an existing
# read-only golden for the version is left alone; a half-built one from an
# earlier run is discarded and rebuilt. Needs provision-host.sh first.
#
# Usage: sudo distro/metal-host/build-golden-disk.sh <bundle-version>
#          [--bundle-url URL] [--bundle-sha256 HEX] [--keep-on-failure]
#   default URL: https://app.matrix-os.com/system-bundles/<version>/matrix-host-bundle.tar.gz
#   default sha256: read from <URL>.sha256
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT
readonly VG=vmvg POOL=pool DISK_SIZE=20G VM_USER=matrix-vm BRIDGE=brmx
readonly STATE_DIR=/var/lib/matrix-hostd
readonly KERNEL="$STATE_DIR/kernel/vmlinuz" INITRD="$STATE_DIR/kernel/initrd.img"
readonly BASE_IMAGE="$STATE_DIR/images/ubuntu-24.04-server-cloudimg-amd64.img"
readonly GUEST_AGENT=/opt/matrix-hostd/guest-agent/agent.mjs
readonly CH=/usr/local/bin/cloud-hypervisor
# Must match hostd's DEFAULT_LIFECYCLE_CONFIG.kernelCmdline.
readonly CMDLINE="console=ttyS0 root=LABEL=cloudimg-rootfs rw memhp_default_state=online memory_hotplug.online_policy=auto-movable page_reporting.page_reporting_order=5"
# The builder sits outside hostd's address range (10.78.0.10-10.78.3.250);
# matrix_hostd's firewall lets only it reach the callback port.
readonly BUILDER_IP=10.78.3.254 BUILDER_MAC=52:54:00:78:03:fe BUILDER_TAP=mxgbuild0
readonly VALIDATE_IP=10.78.3.253 VALIDATE_MAC=52:54:00:78:03:fd VALIDATE_TAP=mxgval0
readonly CALLBACK_ADDR=10.78.0.1 CALLBACK_PORT=9480
readonly BUILD_TIMEOUT_S=4500 VALIDATE_TIMEOUT_S=600

log() { printf 'build-golden-disk: %s\n' "$*"; }
die() { printf 'build-golden-disk: %s\n' "$*" >&2; exit 1; }

version="${1:-}"
[ "$#" -gt 0 ] && shift
[[ "$version" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$ ]] || die "usage: build-golden-disk.sh <bundle-version> [--bundle-url URL] [--bundle-sha256 HEX]"
bundle_url="https://app.matrix-os.com/system-bundles/$version/matrix-host-bundle.tar.gz"
bundle_sha256=""
keep_on_failure=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle-url) [ "$#" -ge 2 ] || die "missing URL"; bundle_url="$2"; shift 2 ;;
    --bundle-sha256) [ "$#" -ge 2 ] || die "missing sha256"; bundle_sha256="$2"; shift 2 ;;
    --keep-on-failure) keep_on_failure=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done
[[ "$bundle_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/%-]*$ ]] || die "bundle URL must be a plain https URL"
[ "$(id -u)" = 0 ] || die "run as root"
for need in "$KERNEL" "$INITRD" "$BASE_IMAGE" "$GUEST_AGENT" "$CH"; do
  [ -f "$need" ] || die "missing $need (run provision-host.sh)"
done
ip link show "$BRIDGE" >/dev/null 2>&1 || die "bridge $BRIDGE missing (run provision-host.sh)"

golden="golden-$version"
building="$golden-building"
validate="$golden-validate"
unit_suffix="$(printf '%s' "$version" | tr -c 'A-Za-z0-9_-' '_')"
build_unit="matrix-golden-build-$unit_suffix.service"
validate_unit="matrix-golden-validate-$unit_suffix.service"
callback_unit="matrix-golden-callback-$unit_suffix.service"
work="$STATE_DIR/golden/$version"
serial_dir=/var/log/matrix-vm

lv_attr() { lvs --noheadings -o lv_attr "$VG/$1" 2>/dev/null | tr -d ' '; }

if [ -n "$(lv_attr "$golden")" ]; then
  [ "$(lv_attr "$golden" | cut -c2)" = r ] || die "$VG/$golden exists but is writable; inspect it before rebuilding"
  log "$VG/$golden already built (read-only); nothing to do"
  exit 0
fi

stop_vm_units() {
  local unit
  for unit in "$build_unit" "$validate_unit" "$callback_unit"; do
    systemctl stop "$unit" 2>/dev/null || true
    systemctl reset-failed "$unit" 2>/dev/null || true
  done
  for tap in "$BUILDER_TAP" "$VALIDATE_TAP"; do
    if ip link show "$tap" >/dev/null 2>&1; then ip link delete "$tap"; fi
  done
}

remove_lv() {
  if [ -n "$(lv_attr "$1")" ]; then lvremove --yes "$VG/$1" >/dev/null; fi
}

succeeded=0
cleanup() {
  stop_vm_units
  remove_lv "$validate"
  if [ "$succeeded" = 0 ]; then
    if [ "$keep_on_failure" = 1 ]; then
      log "keeping $VG/$building and $work for inspection"
    else
      remove_lv "$building"
    fi
  fi
}
trap cleanup EXIT

# A previous run that died mid-way: start over.
stop_vm_units
remove_lv "$validate"
remove_lv "$building"
rm -rf -- "$work"
install -d -m 0710 -o root -g "$VM_USER" "$STATE_DIR/golden"
install -d -m 0750 -o root -g "$VM_USER" "$work"
install -d -m 0750 -o "$VM_USER" -g "$VM_USER" "$serial_dir"

if [ -z "$bundle_sha256" ]; then
  bundle_sha256="$(curl --fail --location --silent --show-error --retry 3 --connect-timeout 10 --max-time 30 "$bundle_url.sha256" | awk '{print $1; exit}')"
fi
[[ "$bundle_sha256" =~ ^[a-f0-9]{64}$ ]] || die "bundle sha256 unavailable or malformed"
log "building $golden from $bundle_url ($bundle_sha256)"

# --- disk -------------------------------------------------------------------
lvcreate --quiet --thin --virtualsize "$DISK_SIZE" --name "$building" "$VG/$POOL" >/dev/null
qemu-img convert -q -f qcow2 -O raw -n "$BASE_IMAGE" "/dev/$VG/$building"
# Only while the builder runs; lvrename later recreates the node as root:disk.
chown "$VM_USER:$VM_USER" "$(readlink -f "/dev/$VG/$building")"

# --- seeds --------------------------------------------------------------------
uuid() { cat /proc/sys/kernel/random/uuid; }
network_config() {
  cat <<EOF
version: 2
ethernets:
  eth0:
    match:
      macaddress: "$1"
    set-name: eth0
    addresses: [$2/22]
    routes:
      - to: default
        via: 10.78.0.1
    nameservers:
      addresses: [1.1.1.1, 9.9.9.9]
EOF
}
make_seed() {
  local name="$1" mac="$2" ip="$3" user_data="$4"
  network_config "$mac" "$ip" >"$work/$name.network-config"
  printf 'instance-id: %s-%s\nlocal-hostname: matrix-golden-%s\n' "$name" "$(uuid)" "$name" >"$work/$name.meta-data"
  cloud-localds --network-config "$work/$name.network-config" "$work/$name.seed.img" "$user_data" "$work/$name.meta-data"
  chown "$VM_USER:$VM_USER" "$work/$name.seed.img"
  chmod 0600 "$work/$name.seed.img"
}

umask 077
openssl rand -hex 32 >"$work/callback-token"
python3 -I "$SCRIPT_DIR/render-user-data.py" builder \
  --template "$REPO_ROOT/distro/customer-vps/golden-snapshot-builder-cloud-init.yaml" \
  --guest-dir "$SCRIPT_DIR/guest" \
  --guest-agent "$GUEST_AGENT" \
  --var "callbackToken=$(cat "$work/callback-token")" \
  --var "callbackUrl=http://$CALLBACK_ADDR:$CALLBACK_PORT/callback" \
  --var "callbackEventId=$(uuid)" \
  --var "builderBootEventId=$(uuid)" \
  --var "bundleVersion=$version" \
  --var "bundleSha256=$bundle_sha256" \
  --var "bundleUrl=$bundle_url" \
  --out "$work/builder.user-data"
make_seed builder "$BUILDER_MAC" "$BUILDER_IP" "$work/builder.user-data"
# The callback token is a builder secret; the seed carries it, so drop the plain copies after use.
umask 022

# --- callback receiver --------------------------------------------------------
: >"$work/callbacks.jsonl"
systemd-run --quiet --unit "$callback_unit" --property=Type=exec \
  /usr/bin/python3 -I "$SCRIPT_DIR/golden-callback-receiver.py" \
  --bind "$CALLBACK_ADDR" --port "$CALLBACK_PORT" \
  --token-file "$work/callback-token" --out "$work/callbacks.jsonl"

# --- VM runner ------------------------------------------------------------------
start_vm() {
  local unit="$1" tap="$2" mac="$3" disk="$4" seed="$5" mem="$6" cpus="$7" vsock="$8"
  ip tuntap add dev "$tap" mode tap user "$VM_USER" group "$VM_USER"
  ip link set dev "$tap" master "$BRIDGE" up
  bridge link set dev "$tap" isolated on
  local -a vsock_args=()
  if [ -n "$vsock" ]; then vsock_args=(--vsock "cid=3,socket=$vsock"); fi
  systemd-run --quiet --unit "$unit" --property=Type=exec \
    --property=User="$VM_USER" --property=Group="$VM_USER" --property=SupplementaryGroups=kvm \
    --property=NoNewPrivileges=yes --property=RuntimeDirectory="matrix-golden/$unit_suffix-$tap" \
    "$CH" --kernel "$KERNEL" --initramfs "$INITRD" --cmdline "$CMDLINE" \
    --cpus "boot=$cpus" --memory "size=${mem}M" \
    --disk "path=$disk,image_type=raw" "path=$seed,image_type=raw,readonly=on" \
    --net "tap=$tap,mac=$mac" "${vsock_args[@]}" \
    --serial "file=$serial_dir/golden-$unit_suffix-$tap.serial" --console off
}

serial_tail() { tail -n 40 "$serial_dir/golden-$unit_suffix-$1.serial" 2>/dev/null | tr -cd '\11\12\15\40-\176' || true; }

start_vm "$build_unit" "$BUILDER_TAP" "$BUILDER_MAC" "/dev/$VG/$building" "$work/builder.seed.img" 8192 4 ""
log "builder running ($build_unit); this takes 10 to 40 minutes"
started=$SECONDS
last_phase=""
while systemctl is-active --quiet "$build_unit"; do
  if [ $((SECONDS - started)) -ge "$BUILD_TIMEOUT_S" ]; then
    serial_tail "$BUILDER_TAP" >&2
    die "builder did not finish within ${BUILD_TIMEOUT_S}s"
  fi
  phase="$(python3 -I -c 'import json,sys
lines=[l for l in open(sys.argv[1]) if l.strip()]
print(json.loads(lines[-1])["payload"].get("phase","") if lines else "")' "$work/callbacks.jsonl")"
  if [ "$phase" != "$last_phase" ]; then log "builder phase: $phase"; last_phase="$phase"; fi
  sleep 10
done
rm -f -- "$work/callback-token" "$work/builder.user-data"
systemctl stop "$callback_unit"
if grep -q '"phase":"failed"' "$work/callbacks.jsonl" || ! grep -q '"phase":"sanitized"' "$work/callbacks.jsonl"; then
  serial_tail "$BUILDER_TAP" >&2
  python3 -I -c 'import json,sys
for l in open(sys.argv[1]):
    p=json.loads(l)["payload"]
    print("callback:", p.get("phase"), p.get("stage",""))' "$work/callbacks.jsonl" >&2
  die "builder did not report a sanitized disk"
fi
log "builder sanitized the disk and powered off after $((SECONDS - started))s"

# --- validation clone ---------------------------------------------------------
lvcreate --quiet --snapshot --setactivationskip n --activate y --name "$validate" "$VG/$building" >/dev/null
chown "$VM_USER:$VM_USER" "$(readlink -f "/dev/$VG/$validate")"
cat >"$work/validate.user-data" <<'EOF'
#cloud-config
runcmd:
  - |
    {
      check() { if "$@" >/dev/null 2>&1; then echo ok; else echo fail; fi; }
      echo "MATRIX-METAL-CHECK kernel=$(uname -r)"
      echo "MATRIX-METAL-CHECK ptp_kvm=$(check grep -q '^ptp_kvm ' /proc/modules)"
      echo "MATRIX-METAL-CHECK ptp0=$(check test -c /dev/ptp0)"
      for unit in phc2sys-kvm matrix-guest-agent matrix-guest-agent-vsock; do
        echo "MATRIX-METAL-CHECK unit_${unit}=$(systemctl is-active "$unit")"
      done
      echo "MATRIX-METAL-CHECK socat_max_children=$(check sh -c 'timeout 1 socat UNIX-LISTEN:/run/mx-socat-probe.sock,fork,max-children=8 /dev/null; [ $? = 124 ]')"
      echo "MATRIX-METAL-CHECK sshd_config=$(check sshd -t)"
      echo "MATRIX-METAL-CHECK guest_ready=$(check test -f /var/lib/matrix-metal-guest/ready)"
      echo "MATRIX-METAL-CHECK sanitized=$(check test -f /var/lib/matrix/golden-snapshot-sanitized)"
      echo "MATRIX-METAL-CHECK system_ready=$(check test -f /opt/matrix/golden-snapshot-system-ready)"
      echo "MATRIX-METAL-CHECK bundle_version=$(tr -d '\r\n' </opt/matrix/app/BUNDLE_VERSION)"
      echo "MATRIX-METAL-CHECK bundle_sha256=$(tr -d '\r\n' </opt/matrix/app/BUNDLE_SHA256)"
      echo "MATRIX-METAL-CHECK done"
    } >/dev/ttyS0 2>&1
EOF
make_seed validate "$VALIDATE_MAC" "$VALIDATE_IP" "$work/validate.user-data"
vsock="/run/matrix-golden/$unit_suffix-$VALIDATE_TAP/vsock.sock"
start_vm "$validate_unit" "$VALIDATE_TAP" "$VALIDATE_MAC" "/dev/$VG/$validate" "$work/validate.seed.img" 2048 2 "$vsock"
validate_serial="$serial_dir/golden-$unit_suffix-$VALIDATE_TAP.serial"
started=$SECONDS
until grep -q 'MATRIX-METAL-CHECK done' "$validate_serial" 2>/dev/null; do
  systemctl is-active --quiet "$validate_unit" || { serial_tail "$VALIDATE_TAP" >&2; die "validation VM exited"; }
  [ $((SECONDS - started)) -lt "$VALIDATE_TIMEOUT_S" ] || { serial_tail "$VALIDATE_TAP" >&2; die "validation timed out"; }
  sleep 2
done
checks="$(grep -a -o 'MATRIX-METAL-CHECK [a-z_0-9-]*=[^[:space:]]*' "$validate_serial" | sed 's/^MATRIX-METAL-CHECK //')"
printf '%s\n' "$checks" | sed 's/^/  /'
expect_check() {
  grep -qx -- "$1=$2" <<<"$checks" || die "validation failed: $1 is not $2"
}
for key in ptp_kvm ptp0 socat_max_children sshd_config guest_ready sanitized system_ready; do expect_check "$key" ok; done
for unit in phc2sys-kvm matrix-guest-agent matrix-guest-agent-vsock; do expect_check "unit_$unit" active; done
expect_check bundle_version "$version"
expect_check bundle_sha256 "$bundle_sha256"

# The host side of the guest agent: the same vsock path hostd uses.
probe_agent() {
  python3 -I - "$vsock" "$1" <<'PY'
import json, socket, sys
path, op = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(30)
s.connect(path)
f = s.makefile("rwb")
f.write(b"CONNECT 1024\n"); f.flush()
if not f.readline().startswith(b"OK "):
    sys.exit("vsock handshake failed")
f.write(json.dumps({"op": op}).encode() + b"\n"); f.flush()
reply = json.loads(f.readline())
if op == "trim" and reply != {"ok": True}:
    sys.exit(f"trim failed: {reply}")
if op == "stats" and not isinstance(reply.get("availableMiB"), (int, float)):
    sys.exit(f"stats failed: {reply}")
print(f"  guest agent {op}: {json.dumps(reply)}")
PY
}
probe_agent stats
# trim writes /proc/sys/vm/drop_caches and compact_memory under the agent's unit hardening.
probe_agent trim
systemctl stop "$validate_unit"
remove_lv "$validate"
log "validation clone passed"

# --- seal -------------------------------------------------------------------------
lvrename "$VG" "$building" "$golden" >/dev/null
lvchange --quiet --permission r "$VG/$golden"
[ "$(lv_attr "$golden" | cut -c2)" = r ] || die "could not make $VG/$golden read-only"
python3 -I - "$STATE_DIR/golden/$version.json" "$version" "$bundle_url" "$bundle_sha256" <<'PY'
import json, os, sys
from datetime import datetime, timezone
out, version, url, sha = sys.argv[1:]
data = {"version": version, "lv": f"vmvg/golden-{version}", "bundleUrl": url, "bundleSha256": sha,
        "builtAt": datetime.now(timezone.utc).isoformat()}
tmp = out + ".tmp"
with open(tmp, "w") as handle:
    json.dump(data, handle, indent=2)
    handle.write("\n")
os.chmod(tmp, 0o644)
os.replace(tmp, out)
PY
succeeded=1
log "built $VG/$golden (read-only)"
