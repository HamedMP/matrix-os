# Metal hosts

A metal host is one rented bare-metal server that runs many Matrix VMs under
Cloud Hypervisor, managed by `matrix-hostd` (`packages/hostd`). Design and
measurements: `specs/2691-runtime-substrates-free-tier/` (spike S7). Linear:
ENG-520.

All scripts live in `distro/metal-host/`, run as root on the host, and are
idempotent: re-running one repairs drift and changes nothing else.

## What a host contains

| Piece | Where |
| --- | --- |
| Cloud Hypervisor v54.1 (pinned sha256) | `/usr/local/bin/cloud-hypervisor`, `/usr/local/bin/ch-remote` |
| Guest kernel and initrd (Ubuntu 24.04 cloud, pinned) | `/var/lib/matrix-hostd/kernel/` |
| Node 24 (pinned tarball) and hostd bundle | `/opt/matrix-hostd/node`, `/opt/matrix-hostd/hostd.mjs` |
| hostd config (tokens, TLS paths, ports), 0600 | `/etc/matrix-hostd/hostd.env` |
| TLS certificate | `/etc/matrix-hostd/tls/cert.pem` and `/etc/matrix-hostd/tls/key.pem` |
| VM disks | thin LVs `vmvg/mx-vm_*`, clones of the read-only `vmvg/golden-<bundle-version>` |
| Memory snapshots | `/var/lib/matrix-hostd/snapshots`, ext4 on its own thin LV `vmvg/hostd-snapshots` (never the root fs) |
| Host swap | thick LV `vmvg/hostd-swap` with zswap in front |
| VM network | bridge `brmx` 10.78.0.1/22, NAT out the public interface |
| Firewall | `matrix-hostd-nft.service` loads `table inet matrix_hostd`. The tenant unit loads `table inet matrix_hostd_tenant` and `table ip matrix_hostd_nat`. |

After an operator replaces the TLS certificate and key, rerun provisioning.
A changed certificate bundle restarts hostd so both HTTPS endpoints load it.

hostd runs as root (it drives LVM, systemd units and taps), so it reaches
each VM's `ch.sock` and `vsock.sock` without group access; the VMM runs as the
unprivileged `matrix-vm` user. It gets `/dev/kvm` through
the `kvm` group, `/dev/userfaultfd` (ondemand restore) and its own disks
through a udev rule; `vm.unprivileged_userfaultfd` stays 0. Taps are created
and brought up by root `ExecStartPre` lines, so the VMM needs no
`CAP_NET_ADMIN`. Each tap binds the guest's assigned MAC and IPv4, filters ARP, and is
policed to 50 Mbit/s. Ingress checks the permanent host-side binding
before forwarding. The tenant firewall drops guest SMTP, private-range
traffic, and new connections to the host. Drain any running pilot
`matrix-vm@` and `matrix-vm-restore@` units before upgrading a host from
the legacy tap setup. Old snapshots without a recorded memory
reservation cold boot from the same disk.

## Provision

Build the bundles on a checkout, copy the checkout to the host, then run
(`--data-disks` is needed only on a fresh host: it adds a `vmdata` partition
in the free space of each disk, mirrors them as `/dev/md/vmdata` and creates
`vmvg` with the thin pool `vmvg/pool` at 95% of it):

```bash
bun run --cwd packages/hostd build:hostd
bun run --cwd packages/hostd build:guest-agent
sudo distro/metal-host/provision-host.sh --host-name <fqdn> [--ingress-port 443] [--data-disks /dev/nvme0n1,/dev/nvme1n1]
```

Install a trusted certificate and matching key before provisioning. Provisioning
preserves the installed pair, including during the last week of validity.
Replace an expired certificate before rerunning. For a disposable smoke host,
pass `--smoke-tls` to generate a self-signed pair when both files are absent.

The host reserves the full virtual size of every VM disk, golden clone,
and snapshot filesystem against physical thin-pool data space. It also
checks the metadata estimate for those allocations. Guest create, golden
build, and snapshot filesystem creation share one allocation lock. The
golden builder can use a portion of the space reserved by the default
guest admission thresholds. Hostd
returns retryable capacity if the reservation cannot fit or if LVM data
or metadata usage exceeds the configured admission thresholds. For an
existing overcommitted pilot, provision additional storage or retire
unused volumes before admitting more guests. The helper does not shrink
or delete existing disks.

The read
is a plain `lvs -o data_percent,metadata_percent vmvg/pool`: `--readonly` skips
the device-mapper status query and prints blank percentages (LVM 2.03.16),
which would refuse every create. `GET /v1/capacity`
reports both as `thinPool`, which is `null` when unreadable or slower than the
endpoint's 2 s probe bound, so placement can prefer hosts with room.

Boots and restores reserve the VM ceiling plus 256 MiB for the VMM,
leaving 32 GiB for the host. An idle VM releases its active reservation
only after the VMM has stopped. A wake refused for capacity keeps its
disk and snapshot for a later attempt.

The management firewall (`nftables.conf`) controls public access: input default deny except
established traffic, SSH on the public interface (key-only sshd, never
removed), anything on `tailscale0`, Headscale (443/tcp, 3478/udp), Tailscale
direct (41641/udp), the ingress and API ports. Forwarding: `brmx` to the
internet (NAT, no SMTP, no private ranges) and `tailscale0` to `brmx`. VMs
on other bridges of the host keep their new outbound connections to the
internet; inbound port forwards into them are dropped, and only `tailscale0`
reaches `brmx`.
`provision-host.sh` dry-runs the rendered ruleset first (`matrix-hostd-nft
check` requires SSH on the public interface to be accepted before any drop,
then `nft -c`), and `matrix-hostd-nft apply` repeats the check before loading.

Every firewall change (rules, helper, parameters or unit) is loaded
unconfirmed by `matrix-hostd-nft arm`: `matrix-hostd-nft.service` runs but is
**not enabled**, `/var/lib/matrix-hostd/firewall-unconfirmed` records when the
window opened, and the transient `matrix-hostd-nft-revert.timer` stops and
disables the unit after 10 minutes. The unit's `ExecStartPre` (`guard`)
refuses to load once that marker is older than 10 minutes, so a reboot (which
loses the transient timer) or any later start fails open instead of bringing
back an unconfirmed management firewall. The independent
`matrix-hostd-tenant-nft.service` keeps guest isolation and NAT in place
through rollback. Hostd and both VM units require that tenant service. Open a **new** SSH session and run
`sudo distro/metal-host/provision-host.sh --confirm-firewall` to keep the
change: it cancels the timer, removes the marker and enables the unit. It
exits non-zero if the revert already happened; then re-run provisioning. Confirmation records a
fingerprint of the rendered ruleset and the helper
(`/var/lib/matrix-hostd/firewall-confirmed.sha256`), and only for the rules
that are loaded: every load records its own fingerprint
(`firewall-loaded.sha256`), and confirm refuses rules on disk that differ from
it (a re-run that installed new files and died before arming). Outside an open window
the unit loads only rules matching it, and provisioning treats any difference
as a change to arm, so rules installed by a run that died before arming are
never reloaded or loaded at boot.

Provisioning installs an `nftables.service` drop-in on metal hosts. A service
restart or reload applies `/etc/nftables.conf` and the rendered Matrix tenant
rules together in one nft transaction. Stopping `nftables.service` leaves
the loaded rules in place so guests keep their network restrictions.

Never run `nft flush ruleset` or reload another tool's ruleset to fix hostd's;
`systemctl reload matrix-hostd-nft` replaces only hostd's tables.

## Build a golden disk

```bash
sudo distro/metal-host/build-golden-disk.sh <bundle-version> [--bundle-url URL] [--bundle-sha256 HEX]
```

It boots a builder VM from the pinned Ubuntu image with the unchanged
`distro/customer-vps/golden-snapshot-builder-cloud-init.yaml` plus the S7
guest part (`guest/metal-guest-setup.sh`: `linux-modules-extra` for the
host-booted kernel, `ptp_kvm`, `phc2sys-kvm.service`, the guest agent and its
vsock bridge). The builder's phase callbacks go to a receiver on
`10.78.0.1:9480` for the length of the build. A throwaway clone then checks
the guest settings and talks to the guest agent over vsock (stats and trim)
before the LV is made read-only, its metadata is written
(`/var/lib/matrix-hostd/golden/<version>.json`), and only then is it renamed
`golden-<bundle-version>`. One build runs per host at a time (a lock under
`/run/lock`); a second one exits with an error. The build directory is removed
afterwards unless `--keep-on-failure` keeps a failed one for inspection.

## Smoke

```bash
sudo distro/metal-host/smoke-host.sh [--golden <version>] [--cycles 2]
```

The host smoke creates a free VM (boot 2048 MiB, max 8192 MiB, 40 GiB)
from the golden disk and checks guest gateway health. It verifies that the
local ingress rejects unauthenticated requests and that the guest's permanent
host network binding is installed on boot and restore and removed on sleep.
It also checks sparse snapshots, the two-second restore target, and complete
teardown.

Use the authenticated staging platform at
`https://app.matrix-os.com/vm/<handle>` to check owner routing and waking
through the public entry point. The disposable host-only smoke VM does not
register with the platform.

## Enable in production

The `Platform Cloud Run` workflow turns metal hosts and the free tier on
only from GitHub environment settings. With none set, both stay off and
nothing new is required. `scripts/ci/platform-metal-env.sh` validates the
settings, preflights the secrets, and verifies the candidate, production and
worker revisions. The worker service copies the candidate revision's
settings, so the sleeper and maintenance passes get the same values.

GitHub environment variables (`production`):

| Variable | Format | Default |
| --- | --- | --- |
| `METAL_HOSTS_ENABLED` | `0` or `1` | `0` |
| `METAL_GOLDEN_VERSION` | `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, required when metal is on | none |
| `METAL_HOSTD_CA_PEM_ENABLED` | `true` (bind the hostd CA) or `false` (publicly trusted hostd certificate) | `true` |
| `METAL_POOL_MAX_DATA_PERCENT`, `METAL_POOL_MAX_METADATA_PERCENT` | integer 1-100, optional | provisioner defaults 85 / 80 |
| `MATRIX_FREE_TIER_ENABLED` | `0` or `1`; needs metal on | `0` |
| `MATRIX_FREE_TIER_MAX_RUNTIMES` | integer 1-999999, required when the free tier is on | none |
| `MATRIX_FREE_TIER_INVITE_REQUIRED` | `true` or `false` | `true` |
| `MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD` | positive integer, micro-USD; unset means no free funded AI | none |
| `MATRIX_FREE_TIER_SLEEP_ENABLED` | `0` or `1`; needs metal on | `0` |

Secret Manager secrets in the platform GCP project, bound as `latest`. The
Cloud Run service account needs `roles/secretmanager.secretAccessor` on each:

| Env name | Secret | Format |
| --- | --- | --- |
| `METAL_HOSTD_API_TOKEN` | `metal-hostd-api-token` | 32-512 printable ASCII, no whitespace or trailing newline; hostd's API token |
| `METAL_HOSTD_INGRESS_TOKEN` | `metal-hostd-ingress-token` | same format, a different value; hostd's ingress token |
| `METAL_HOSTD_CA_PEM` | `metal-hostd-ca-pem` | PEM CA certificate for the hostd TLS certificate (only when `METAL_HOSTD_CA_PEM_ENABLED=true`) |

Enable order:

1. Provision the host, build the golden disk, and register its platform host row.
2. Create the secrets and grant the runtime service account access.
3. Set `METAL_HOSTS_ENABLED=1` and `METAL_GOLDEN_VERSION`, then deploy.
4. Set `MATRIX_FREE_TIER_ENABLED=1`, `MATRIX_FREE_TIER_MAX_RUNTIMES`, the
   optional spend cap and `MATRIX_FREE_TIER_SLEEP_ENABLED=1`, then deploy again.

To turn it off, set the flags back to `0` and deploy. The full deploy
replaces the service environment, and verification fails if any metal or
free-tier setting remains.


## Recovery

- Locked out after a firewall change: wait out the 10-minute window. The
  revert timer stops the firewall; if the host rebooted meanwhile, the unit
  is not enabled and its guard refuses the stale change, so the host comes
  up without hostd's firewall. Either way SSH returns; re-run
  provision-host.sh, fix the cause and confirm. From a path that still
  reaches the host you can also run `systemctl disable --now
  matrix-hostd-nft.service` (its stop removes the public management table).
- hostd will not start: `journalctl -u matrix-hostd`. Startup errors name the
  bad config keys, never values.
- A VM failed: `GET /v1/vms/<id>` shows `failed` and `failedDuring`.
  Read serial output with `journalctl --namespace=matrix-vm -u matrix-vm@<id>.service -u matrix-vm-restore@<id>.service`.
