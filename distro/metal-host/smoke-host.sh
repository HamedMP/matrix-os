#!/usr/bin/env bash
# Live smoke for a provisioned metal host. Creates a free VM over the host
# API, verifies the guest gateway, and checks the host network binding and
# the ingress authentication gate. Runs suspend/resume cycles, checks sparse
# snapshots on the snapshot LV, then verifies teardown. Authenticated owner
# routing is covered by the platform smoke on the canonical application URL.
#
# Usage: sudo distro/metal-host/smoke-host.sh [--golden VERSION] [--cycles N] [--keep-on-failure]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly SCRIPT_DIR REPO_ROOT
readonly ENV_FILE=/etc/matrix-hostd/hostd.env
readonly STATE_DIR=/var/lib/matrix-hostd
readonly SNAPSHOTS="$STATE_DIR/snapshots"
readonly RESUME_LIMIT_MS=2000
readonly BOOT_TIMEOUT_S=900

golden="" cycles=2 keep_on_failure=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --golden) [ "$#" -ge 2 ] || exit 2; golden="$2"; shift 2 ;;
    --cycles) [ "$#" -ge 2 ] || exit 2; cycles="$2"; shift 2 ;;
    --keep-on-failure) keep_on_failure=1; shift ;;
    *) echo "usage: smoke-host.sh [--golden VERSION] [--cycles N] [--keep-on-failure]" >&2; exit 2 ;;
  esac
done
[[ "$cycles" =~ ^[1-9]$ ]] || { echo "smoke: --cycles must be 1-9" >&2; exit 2; }

started=$SECONDS
step() { printf '[%4ds] %s\n' "$((SECONDS - started))" "$*"; }
pass() { printf '[%4ds] PASS %s\n' "$((SECONDS - started))" "$*"; }
die() { printf '[%4ds] FAIL %s\n' "$((SECONDS - started))" "$*" >&2; exit 1; }
now_ms() { date +%s%3N; }
# Never `cmd | grep -q` under pipefail (SIGPIPE turns a match into a failure).
has() { local pattern="$1" out; shift; out="$("$@" 2>/dev/null)" || true; grep -q -- "$pattern" <<<"$out"; }

[ "$(id -u)" = 0 ] || die "run as root"
[ -f "$ENV_FILE" ] || die "missing $ENV_FILE (run provision-host.sh)"
env_value() { sed -n "s/^$1=//p" "$ENV_FILE"; }
api_port="$(env_value HOSTD_API_PORT)"
ingress_port="$(env_value HOSTD_INGRESS_PORT)"
ingress_port="${ingress_port:-443}"
api="https://127.0.0.1:${api_port:-8443}"

if [ -z "$golden" ]; then
  golden="$(lvs --noheadings -o lv_name,lv_attr vmvg 2>/dev/null | awk '$1 ~ /^golden-/ && $1 !~ /-(building|validate)$/ && substr($2, 2, 1) == "r" {sub(/^golden-/, "", $1); print $1}' | sort | tail -n 1)"
fi
[ -n "$golden" ] || die "no read-only golden disk found (run build-golden-disk.sh)"
meta="$STATE_DIR/golden/$golden.json"
[ -f "$meta" ] || die "missing $meta"
bundle_sha256="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["bundleSha256"])' "$meta")"

work="$(mktemp -d)"
chmod 0700 "$work"
# Tokens go to curl through 0600 header files, never on a command line.
printf 'Authorization: Bearer %s\n' "$(env_value HOSTD_API_TOKEN)" >"$work/api-auth"
chmod 0600 "$work/api-auth"

vm_id=""
cleanup() {
  local status=$?
  if [ -n "$vm_id" ] && [ "$status" -ne 0 ]; then
    if [ "$keep_on_failure" = 1 ]; then
      echo "smoke: keeping VM $vm_id for inspection" >&2
    else
      curl -ks --max-time 120 -H @"$work/api-auth" -X DELETE "$api/v1/vms/$vm_id" >/dev/null || echo "smoke: cleanup DELETE failed" >&2
    fi
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT

# api <method> <path> [json-body-file] -> body on stdout, status in $work/status
api_call() {
  local method="$1" path="$2" body="${3:-}"
  local -a extra=()
  if [ -n "$body" ]; then extra=(-H 'content-type: application/json' --data-binary @"$body"); fi
  curl -ks --max-time 150 -o "$work/body" -w '%{http_code}' -H @"$work/api-auth" -X "$method" "${extra[@]}" "$api$path" >"$work/status"
  cat "$work/body"
}
json_field() { python3 -I -c 'import json,sys; v=json.load(sys.stdin); print(v.get(sys.argv[1], "") if isinstance(v, dict) else "")' "$1"; }
vm_state() { api_call GET "/v1/vms/$vm_id" | json_field state; }
vm_ingress_binding() { ip -4 neigh show to "$vm_ip" dev "$bridge" nud permanent; }
check_ingress_binding() {
  local binding
  binding="$(vm_ingress_binding)"
  [[ "$binding" == *"lladdr $vm_mac PERMANENT"* ]] || die "host ingress binding missing for $vm_id"
}
wait_state() {
  local want="$1" limit="$2" begin=$SECONDS state=""
  while [ $((SECONDS - begin)) -lt "$limit" ]; do
    state="$(vm_state)"
    [ "$state" = "$want" ] && return 0
    [ "$state" = failed ] && die "VM entered failed state while waiting for $want"
    sleep 1
  done
  die "VM is $state, not $want, after ${limit}s"
}

# --- create ---------------------------------------------------------------------
handle="smoke-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
ssh-keygen -q -t ed25519 -N '' -C matrix-smoke-support -f "$work/support" >/dev/null
python3 -I "$SCRIPT_DIR/render-user-data.py" smoke \
  --template "$REPO_ROOT/distro/customer-vps/cloud-init.yaml" \
  --var "handle=$handle" \
  --var "imageVersion=$golden" \
  --var "targetBundleSha256=$bundle_sha256" \
  --var "supportPublicKey=$(cat "$work/support.pub")" \
  --out "$work/user-data"
python3 -I - "$work/user-data" "$handle" "$golden" >"$work/create.json" <<'PY'
import json, sys
user_data, handle, golden = sys.argv[1:]
print(json.dumps({
    "machineId": f"smoke_{handle.removeprefix('smoke-')}", "generation": 1, "handle": handle,
    "tier": "free", "bootMiB": 2048, "maxMiB": 8192, "diskGiB": 40,
    "userData": open(user_data).read(), "goldenVersion": golden,
}))
PY
step "golden $golden, handle $handle"
created="$(api_call POST /v1/vms "$work/create.json")"
case "$(cat "$work/status")" in 201|202) ;; *) die "create returned $(cat "$work/status"): $created" ;; esac
vm_id="$(printf '%s' "$created" | json_field id)"
vm_ip="$(printf '%s' "$created" | json_field privateIPv4)"
[[ "$vm_id" =~ ^vm_[a-f0-9]{24}$ ]] || die "unexpected VM id"
pass "created $vm_id at $vm_ip (free: boot 2048 MiB, max 8192 MiB, disk 40 GiB)"

lv="vmvg/mx-$vm_id"
lvs "$lv" >/dev/null 2>&1 || die "no LV $lv"
has "golden-$golden" lvs --noheadings -o origin "$lv" || die "$lv is not a clone of golden-$golden"
[ "$(stat -L -c %U "/dev/$lv")" = matrix-vm ] || die "/dev/$lv is not owned by matrix-vm"
lv_bytes="$(lvs --noheadings --nosuffix --units b -o lv_size "$lv" | tr -d ' ')"
[ "$lv_bytes" = "$((40 * 1024 * 1024 * 1024))" ] || die "$lv is $lv_bytes bytes, not the requested 40 GiB"
pass "disk $lv is a thin clone of golden-$golden owned by matrix-vm"

# --- boot -------------------------------------------------------------------------
wait_state running 60
begin=$SECONDS
until [ "$(curl -ks --max-time 3 -o /dev/null -w '%{http_code}' "https://$vm_ip/health")" = 200 ]; do
  [ $((SECONDS - begin)) -lt "$BOOT_TIMEOUT_S" ] || die "gateway not healthy after ${BOOT_TIMEOUT_S}s (see journalctl --namespace=matrix-vm -u matrix-vm@$vm_id.service)"
  sleep 3
done
pass "gateway healthy $((SECONDS - begin))s after create"
# The LV is 40 GiB; prove the guest grew its root into it (cloud-init growpart
# and resizefs). The customer cloud-init installs the smoke's support key.
guest_ssh() {
  ssh -i "$work/support" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "matrix-support@$vm_ip" "$@"
}
begin=$SECONDS
root_bytes=""
until root_bytes="$(guest_ssh df -B1 --output=size / 2>/dev/null | tail -n 1 | tr -d ' ')" && [[ "$root_bytes" =~ ^[0-9]+$ ]]; do
  [ $((SECONDS - begin)) -lt 120 ] || die "no SSH to matrix-support@$vm_ip to read the guest root size"
  sleep 3
done
[ "$root_bytes" -ge "$((38 * 1024 * 1024 * 1024))" ] || die "guest root is $root_bytes bytes; it did not grow into the 40 GiB disk"
pass "guest root filesystem is $((root_bytes / 1048576)) MiB on the 40 GiB disk"
vmm_pid="$(systemctl show -p MainPID --value "matrix-vm@$vm_id.service")"
[ "$(ps -o user= -p "$vmm_pid" | tr -d ' ')" = matrix-vm ] || die "VMM does not run as matrix-vm"
tap="$(sed -n 's/^TAP=//p' "$STATE_DIR/vms/$vm_id/unit.env")"
has 'rate 50Mbit' tc filter show dev "$tap" ingress || die "tap is not policed at 50 Mbit/s"
pass "VMM pid $vmm_pid runs as matrix-vm; tap policed at 50 Mbit/s"
bridge="$(sed -n 's/^BRIDGE=//p' "$STATE_DIR/vms/$vm_id/unit.env")"
vm_mac="$(api_call GET "/v1/vms/$vm_id" | json_field mac)"
[[ "$vm_mac" =~ ^([0-9a-f]{2}:){5}[0-9a-f]{2}$ ]] || die "unexpected VM MAC"
check_ingress_binding
pass "guest has its permanent host ingress binding"
[ "$(curl -ks --max-time 10 -o /dev/null -w '%{http_code}' "https://127.0.0.1:$ingress_port/health")" = 401 ] \
  || die "ingress accepted a request without x-matrix-host-auth"
pass "ingress rejects requests without x-matrix-host-auth"

# --- suspend / resume ----------------------------------------------------------------
for cycle in $(seq 1 "$cycles"); do
  printf '{}' >"$work/empty.json"
  api_call POST "/v1/vms/$vm_id/suspend" "$work/empty.json" >/dev/null
  [ "$(cat "$work/status")" = 202 ] || die "suspend returned $(cat "$work/status")"
  wait_state suspended 180
  snap="$SNAPSHOTS/$vm_id"
  [ -f "$snap/memory-ranges" ] || die "no memory snapshot in $snap"
  has 'hostd--snapshots' findmnt -n -o SOURCE --target "$snap" || die "snapshot is not on the snapshot LV"
  apparent="$(stat -c %s "$snap/memory-ranges")"
  allocated="$(( $(stat -c %b "$snap/memory-ranges") * $(stat -c %B "$snap/memory-ranges") ))"
  [ "$allocated" -lt "$apparent" ] || die "snapshot is not sparse ($allocated of $apparent bytes allocated)"
  pass "cycle $cycle: suspended; snapshot on hostd-snapshots LV, sparse: $((allocated / 1048576)) MiB on disk of $((apparent / 1048576)) MiB"
  systemctl is-active --quiet "matrix-vm@$vm_id.service" && die "VMM still running while suspended"
  binding="$(vm_ingress_binding)"
  [ -z "$binding" ] || die "host ingress binding still present while suspended"
  pass "cycle $cycle: host ingress binding removed while suspended"

  printf '{"budgetMs":8000}' >"$work/resume.json"
  t0="$(now_ms)"
  result="$(api_call POST "/v1/vms/$vm_id/resume" "$work/resume.json")"
  elapsed=$(( $(now_ms) - t0 ))
  [ "$(printf '%s' "$result" | json_field state)" = running ] || die "resume returned $(cat "$work/status"): $result"
  [ "$elapsed" -lt "$RESUME_LIMIT_MS" ] || die "resume to gateway health took ${elapsed} ms (limit ${RESUME_LIMIT_MS} ms)"
  restore_unit="matrix-vm-restore@$vm_id.service"
  systemctl is-active --quiet "$restore_unit" || die "$restore_unit is not running"
  has 'memory_restore_mode=ondemand' systemctl show -p ExecStart --value "$restore_unit" || die "restore is not ondemand"
  restore_pid="$(systemctl show -p MainPID --value "$restore_unit")"
  [ "$(ps -o user= -p "$restore_pid" | tr -d ' ')" = matrix-vm ] || die "restored VMM does not run as matrix-vm"
  [ "$(curl -ks --max-time 3 -o /dev/null -w '%{http_code}' "https://$vm_ip/health")" = 200 ] || die "gateway not healthy after resume"
  check_ingress_binding
  pass "cycle $cycle: resume to gateway health in ${elapsed} ms (ondemand restore, VMM pid $restore_pid as matrix-vm)"
done

# --- destroy -------------------------------------------------------------------------
api_call DELETE "/v1/vms/$vm_id" >/dev/null
[ "$(cat "$work/status")" = 204 ] || die "destroy returned $(cat "$work/status")"
api_call GET "/v1/vms/$vm_id" >/dev/null
[ "$(cat "$work/status")" = 404 ] || die "record still served after destroy"
lvs "$lv" >/dev/null 2>&1 && die "LV $lv left behind"
[ -e "$STATE_DIR/vms/$vm_id" ] && die "record directory left behind"
[ -e "$SNAPSHOTS/$vm_id" ] && die "snapshot left behind"
for unit in "matrix-vm@$vm_id.service" "matrix-vm-restore@$vm_id.service"; do
  state="$(systemctl show -p ActiveState --value "$unit")"
  [ "$state" = inactive ] || die "$unit is $state after destroy"
done
ip link show "$tap" >/dev/null 2>&1 && die "tap $tap left behind"
vm_id_done="$vm_id"
vm_id=""
pass "destroyed $vm_id_done: no LV, record, snapshot or tap left; units inactive"
step "smoke passed in $((SECONDS - started))s"
