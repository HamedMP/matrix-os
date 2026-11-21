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
| TLS certificate | `/etc/matrix-hostd/tls/` (self-signed for smoke; production installs a real one) |
| VM disks | thin LVs `vmvg/mx-vm_*`, clones of the read-only `vmvg/golden-<bundle-version>` |
| Memory snapshots | `/var/lib/matrix-hostd/snapshots`, ext4 on its own thin LV `vmvg/hostd-snapshots` (never the root fs) |
| Host swap | thick LV `vmvg/hostd-swap` with zswap in front |
| VM network | bridge `brmx` 10.78.0.1/22, NAT out the public interface |
| Firewall | `table inet matrix_hostd` and `table ip matrix_hostd_nat` only, loaded by `matrix-hostd-nft.service` |

hostd runs as root (it drives LVM, systemd units and taps), so it reaches
each VM's `ch.sock` and `vsock.sock` without group access; the VMM runs as the
unprivileged `matrix-vm` user. It gets `/dev/kvm` through
the `kvm` group, `/dev/userfaultfd` (ondemand restore) and its own disks
through a udev rule; `vm.unprivileged_userfaultfd` stays 0. Taps are created
and brought up by root `ExecStartPre` lines, so the VMM needs no
`CAP_NET_ADMIN`. Each tap is policed to 50 Mbit/s and the firewall drops VM
SMTP (port 25) and any VM traffic to private ranges or the host.

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

The firewall (`nftables.conf`) owns the host: input default deny except
established traffic, SSH on the public interface (key-only sshd, never
removed), anything on `tailscale0`, Headscale (443/tcp, 3478/udp), Tailscale
direct (41641/udp), the ingress and API ports. Forwarding: `brmx` to the
internet (NAT, no SMTP, no private ranges) and `tailscale0` to `brmx`.
`provision-host.sh` dry-runs the rendered ruleset first (`matrix-hostd-nft
check` requires SSH on the public interface to be accepted before any drop,
then `nft -c`), and `matrix-hostd-nft apply` repeats the check before loading.

Every firewall change arms `matrix-hostd-nft-revert.timer`: after 10 minutes
it disables hostd's tables again. Open a **new** SSH session and run
`sudo distro/metal-host/provision-host.sh --confirm-firewall` to keep them.

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
before the LV is renamed `golden-<bundle-version>` and made read-only.
Metadata: `/var/lib/matrix-hostd/golden/<version>.json`.

## Smoke

```bash
sudo distro/metal-host/smoke-host.sh [--golden <version>] [--cycles 2]
```

It uses only the hostd API and ingress: creates a free VM (boot 2048 MiB,
max 8192 MiB, 20 GiB) from the golden disk, waits for gateway health, checks
the ingress routes `<handle>.matrix-os.com` (and rejects requests without
`x-matrix-host-auth`), runs suspend/resume cycles (sparse snapshot on the
snapshot LV, `runtime_asleep` while asleep, resume to gateway health under
2 s from an ondemand restore run as `matrix-vm`), and destroys the VM,
checking no LV, record, snapshot, tap or active unit is left.

## Recovery

- Locked out after a firewall change: wait for the revert timer. Otherwise,
  from a path that still reaches the host (SSH over the tailnet to
  `tailscale0`), run `systemctl disable --now matrix-hostd-nft.service` (its
  stop removes hostd's tables) and fix
  `/etc/matrix-hostd/nft.env`. Last resort: Scaleway rescue boot, mount the
  root filesystem, delete
  `etc/systemd/system/multi-user.target.wants/matrix-hostd-nft.service`, boot
  normally, and restart any VMs the reboot stopped.
- hostd will not start: `journalctl -u matrix-hostd`. Startup errors name the
  bad config keys, never values.
- A VM failed: `GET /v1/vms/<id>` shows `failed`/`failedDuring`; the serial
  log is `/var/log/matrix-vm/<id>.serial`.
