# S7: dense Matrix VMs with dynamic memory on one bare-metal host

**Verdict: pass.** One rented bare-metal host runs the unchanged Matrix host bundle in
Cloud Hypervisor VMs that grow and shrink memory, sleep to disk, and wake in about
1.5 seconds. Linear: ENG-513. Run 2026-11-20.

## Environment

- Host: Scaleway Elastic Metal EM-I620E-NVMe, nl-ams-2, hourly (EUR 1.863/h, EUR
  679.99/month). AMD EPYC 8534P, 64 cores / 128 threads, 576 GB DDR5, 2 x 3.84 TB NVMe.
  The same model was out of stock in every other zone at order time.
- Host OS: Ubuntu 24.04, kernel 6.8.0-146. 200 GB RAID1 root; the rest of both disks is a
  RAID1 LVM thin pool (3.1 TB) holding one read-only base image and one thin snapshot
  per VM.
- Hypervisor: Cloud Hypervisor v54.1 static binary (checksum from the GitHub release).
  Direct kernel boot with Ubuntu's published 24.04 cloud kernel and initrd.
- Guest memory: virtio-mem (boot size plus hotplug up to 128 GiB), virtio-balloon with
  free page reporting, kernel arguments `memhp_default_state=online
  memory_hotplug.online_policy=auto-movable page_reporting.page_reporting_order=5`.
- Network: one Linux bridge, NAT out, bridge port isolation between VMs, nftables
  default-deny on the host. Operator and tester access through self-hosted Headscale
  (v0.29.7) with the host as a subnet router and per-user ACLs.
- Guest software: the stable host bundle (`v2026.11.20-2087`) installed by the unchanged
  `distro/customer-vps/cloud-init.yaml`, rendered with local values and not registered
  with the platform. Two changes were needed for an unregistered VM: a pre-created
  `/opt/matrix/restore-complete` (the restore gate cannot reach R2) and the shell's
  existing self-hosted mode (`MATRIX_SELF_HOSTED=1`, nginx Basic Auth, from
  `scripts/install-server.sh`).

Throwaway tooling (`spike-vm`, `render-user-data.py`, `wake-bench.sh`,
`minmem-bench.sh`) lived on the host and in the session scratchpad; it is not product
code.

## Results

### Memory elasticity

| Test | Result |
| --- | --- |
| Boot to login, plain Ubuntu | about 10 s; 696 MiB host RSS |
| Grow 4 to 32 GiB while running | works; host RSS follows guest use, not size |
| Guest frees 20 GiB | host RSS 18.9 GB to 2.35 GB within 20 s (free page reporting) |
| Shrink 32 to 8 GiB | 5 s |
| Guest page cache | held until trimmed (7.1 GB after reading a 6 GiB file, 1.0 GB after `drop_caches`) |

Free page reporting only returns free blocks of at least the reporting order (default
2 MiB). A running Matrix VM dropped from 3.55 GB to 2.14 GB host RSS after guest
compaction, and to 1.66 GB with the order lowered to 5 (128 KiB). A memory controller
must trim cache and compact, not only rely on reporting.

### Minimum memory for Matrix

Fixed boot memory, no hotplug, guest has the bundle's 8 GB swap file:

| Boot memory | Comes up | Shell ready | API ready | Swap used | Pages swapped in | OOM kills |
| --- | --- | --- | --- | --- | --- | --- |
| 1 GiB | yes | 23.5 s | 35.1 s | 875 MB | 186,791 (thrashing) | 0 |
| 1.5 GiB | yes | 21.1 s | 32.0 s | 432 MB | 33,981 | 0 |
| 2 GiB | yes | 21.2 s | 30.8 s | 171 MB | 3,693 | 0 |
| 3 GiB | yes | 20.4 s | 28.9 s | 0 | 0 | 0 |

The working set is about 1.6 GB. **Decision: 2 GiB boot floor**, grown by virtio-mem
under pressure. At 2 GiB one unit was in a failed state at the check; it was not
identified and must be rechecked with the memory controller.

### Sleep and wake (bench VM, 4 GiB, Matrix running)

| | Round 1 | Round 2 | Round 3 |
| --- | --- | --- | --- |
| Restore + resume | 63 ms | 60 ms | 58 ms |
| Gateway API answers | 1.07 s | 0.87 s | 0.71 s |
| Logged-in shell page answers | 1.72 s | 1.48 s | 1.29 s |
| Host RSS after wake | 909 MiB | 773 MiB | 699 MiB |
| Sleep (trim + snapshot + hole punch) | 10.9 s | 8.1 s | 8.2 s |
| Snapshot on disk | 3.3 GB | 2.9 GB | 2.3 GB |

- Restore uses `memory_restore_mode=ondemand` (userfaultfd), so only touched pages load.
  The default copy mode loaded the whole image and left pages the guest had already
  reported as free resident on the host.
- The snapshot file is written at full guest size and then made sparse with
  `fallocate --dig-holes`; this runs after the VM has stopped. A synthetic idle guest
  went to 563 MB on disk. The Matrix snapshots were larger because the snapshot ran
  within a second of trimming, before freed pages were reported; waiting a few seconds or
  `init_on_free=1` should shrink them.
- Cold power-on: 21.8 s to the shell page, 31.1 s to the API. Shutdown: 3 s. Parked owners
  must be suspended, not shut down.
- A process running in the guest survived every snapshot and restore.

### Clock after restore

The guest clock comes back behind by the time it slept. chrony with network sources did
not step reliably (it marked the host clock a falseticker). Working fix: load `ptp_kvm`
(in `linux-modules-extra`) and run `phc2sys -s /dev/ptp0 -c CLOCK_REALTIME -S 0.5`;
measured in-guest offset 9 microseconds one second after resume.

### Bootstrap

The unchanged customer cloud-init brought a VM from boot to a working Matrix computer in
about 130 s (175 s wall from VM start). Re-running the bootstrap on the same machine
fails the "matrix user quiescence" check because the first Postgres container is still
running; provisioning must be one-shot per VM.

### Density (100 Matrix clones at 2 GiB, same host)

Clones of an installed Matrix disk, each with its own address and cloud-init instance,
booted 20 at a time. No memory controller ran, so every VM kept its full 2 GiB floor.

| Measurement | Result |
| --- | --- |
| Boot of each batch of 20 (to API ready) | about 42 s; load average 18 to 40 on 128 threads |
| 100 awake, settled 2 minutes | host used 239 GB (15 GB baseline); VM RSS average 1,984 MiB |
| Host memory per awake VM, all-in | about 2.24 GB |
| Suspend all 100 (16 at a time) | 159 s; host used fell to 39 GB |
| Snapshot storage | 179 GB for 82 snapshots (about 2.2 GB each, not trimmed first) |
| Wake one VM while the others sleep | 463 to 541 ms to API ready (10 of 10) |

- At 2.24 GB per awake VM, about 240 VMs fit awake on this host before any trimming;
  with the controller's trim (about 1.7 GB measured earlier) about 300.
- If 10 to 25 percent of owners are awake at once, memory supports roughly 1,000 to 2,400
  owners per host. Disk then binds first: about 2 GB of snapshot plus the disk delta per
  sleeping owner against a 3.1 TB pool is roughly 1,000 owners, unless snapshots shrink.
- **Failure found:** snapshots were written to the 186 GB root filesystem, which filled;
  18 snapshots failed with "No space left on device" and the throwaway tool then stopped
  those VMs without a saved state. Production must keep snapshots in the data pool,
  check free space first, and never stop a VM whose snapshot failed.
- Not measured: a simultaneous wake of 90 VMs (the run stopped when it reached VMs whose
  snapshots had failed).

## Product bugs found

- Self-hosted shell: Chat and Files call Clerk `useAuth` without `ClerkProvider` and crash
  the shell; a persisted open Chat window then breaks every load. Fixed in PR #3521
  (ENG-514).

## Not measured yet

- A burst wake of many VMs at once, and density with the memory controller running.
- Memory controller behaviour under real use.
- Cross-host move (live migration or suspend-copy-resume).
- KSM savings and its cross-tenant side-channel trade-off.

## Implications for this spec

The VMs run the full VPS runtime (systemd, local Postgres, Terminal), so most of the
container runtime profile (Stack B) exists only because of the Lambda constraints. See
the bare-metal design revision for the proposed substrate change.
