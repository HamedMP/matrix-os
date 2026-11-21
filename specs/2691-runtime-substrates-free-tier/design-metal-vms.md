# Design revision: free tier on Matrix-operated bare-metal VMs

**Status**: Draft for approval. Revises spec 2691 decision D1 (research.md R4).
**Tracking**: ENG-513 (spike). Implementation ticket and stack ticket to follow approval.
**Evidence**: [spikes/s7-bare-metal-vms.md](spikes/s7-bare-metal-vms.md).

## Intent

Every free Matrix user gets the **full Matrix computer**, small and sleeping: the same
host bundle a paid VPS runs (Chat, apps, Terminal, coding agents, Files, owner
Postgres), in a VM with a 2 GiB memory floor that sleeps when idle and wakes in about
1.5 seconds. Many VMs share one rented bare-metal host. Later, paid plans move onto the
same hosts with more memory and less or no sleeping, so an upgrade is a policy change on
the same VM, not a data migration.

Why: the per-user Hetzner VPS is too expensive to give away, and the container design
in this spec (AWS Lambda MicroVMs) forced a reduced runtime (no systemd, no Terminal or
agents, home hydrated from the object store on every wake, shared Postgres, an 8 hour
unit lifetime). The spike shows the full runtime fits in about 1.7 GB of host memory
when awake and far less when asleep.

## Goals

1. A new person signs up for free, without a card, and reaches a working Matrix desktop.
2. A free computer sleeps when idle and wakes on the next request within about 2 seconds
   to the shell page (measured 1.3 to 1.7 s).
3. Scheduled work keeps running while the owner is away: cron, background agents, and
   channel deliveries wake the VM on schedule.
4. One host serves a few hundred free owners, most asleep. Exact density comes from the
   load test before open signup.
5. Losing a host loses no saved work beyond the backup interval, and affected owners are
   restored onto another host without operator data surgery.
6. The same substrate can later run paid owners.

## Non-goals

- Moving existing paid Hetzner owners onto the hosts in this work.
- Live migration of running VMs. Moves between hosts are suspend, copy, resume (section
  8); host loss is restore from backup.
- Multi-region placement or high availability for a single VM.
- A Matrix-run object store or database: R2 and the per-VM Postgres stay as they are.
- Replacing Hetzner. It remains the paid provider until a separate decision.

## Anti-goals

Kept from spec 2691, unchanged: a free owner's code reaches another owner's data, a
platform secret, or the host; free usage without a hard spend ceiling; a free owner loses
saved work because compute stopped; upgrading loses data; a paid owner's routing,
billing, or data changes because the free tier exists or fails. Added:

- One owner's VM degrades every other VM on the host (CPU, memory, disk, or network
  starvation) without the platform noticing and acting.
- The hosts become a spam, mining, or attack origin that gets Matrix's IP ranges blocked.

## Constraints

- Constitution: TDD, defense in depth, Kysely/Postgres only, owner data stays the owner's.
- AGENTS.md "Production is VPS-native only": the customer runtime stays a host-systemd
  bundle; it now runs in a VM we operate instead of a Hetzner VM. This needs the FR-017
  amendment already planned in Stack F.
- No per-handle subdomains for users; routing stays session-based on `app.matrix-os.com`.
- The platform runs on Cloud Run with no private network to customer machines today.
- Platform code assumes Hetzner throughout (`HetznerClient`, `hetzner_server_id`,
  `public_ipv4` routing, Hetzner golden snapshots, register requires `hetznerServerId`).

## Approaches considered

| | Approach | Why not / why |
| --- | --- | --- |
| **A (chosen)** | Our hosts become a second machine provider. A host agent runs Cloud Hypervisor VMs; the platform gets a provider abstraction with Hetzner and Metal implementations, plus sleep/wake. VMs boot the same bundle and register through the existing flow. | Reuses provisioning, registration, routing headers, deploy, R2 backups, and upgrades. New work is the host agent, memory controller, placement, sleep policy, and abuse controls. |
| B | Kubernetes with KubeVirt or Kata | Operates a large control plane for one job, and neither gives virtio-mem resize plus 60 ms lazy snapshot restore, which the spike showed carry the economics. |
| C | Proxmox cluster | Mature tooling and live migration, but no fast lazy restore; sleep/wake would take tens of seconds and each VM costs more memory. |
| (current) | Spec 2691 container on AWS Lambda MicroVMs | Reduced runtime and a second runtime profile to maintain. Superseded for the free tier by this revision. |

## Design

### 1. Hosts

- Hardware: Scaleway Elastic Metal EM-I620E-NVMe (576 GB, 64 cores, 2 x 3.84 TB NVMe),
  monthly billing once committed. Start with **two hosts** so one can fail or be patched.
  Dedibox CORE-10-XXL (same hardware, 36-month price) is the cost step after the free
  tier proves out.
- Host OS: Ubuntu 24.04, provisioned by a script in the repo (no hand setup): RAID1 root,
  RAID1 LVM thin pool for VM disks, nftables default deny, Cloud Hypervisor and the
  guest kernel pinned per host release with recorded checksums.
- Operator access: SSH only over the operator tailnet (Headscale, as in the spike).
  Public ports: 443 (ingress) and the host-agent port restricted to the platform.

### 2. Host agent (`matrix-hostd`)

A small service on each host that owns every VM on it. The platform is its only caller.

- API (HTTPS, mutual TLS with a platform client certificate, plus a per-host bearer;
  every call has a timeout and typed error codes, no provider or path details in errors):
  `createVm`, `start`, `suspend`, `resume`, `stop`, `destroy`, `setMemoryPolicy`,
  `stats`, `list`. Idempotent by machine id and generation.
- Each VM runs as its own systemd unit with an unprivileged user, Cloud Hypervisor's
  seccomp filters, a cgroup for CPU weight and quota, disk I/O limits, and a per-VM tap
  with bridge port isolation.
- State of record for "what runs here" is the host agent's local store, reconciled
  against the platform's `user_machines` rows by the existing reconciler.

### 3. VM image and provisioning

- A **golden disk per host-bundle release**: a VM built once from the unchanged customer
  cloud-init, then sanitized with the existing `matrix-golden-snapshot-sanitize`, stored
  as a read-only thin LV on each host. New VMs are thin snapshots of it and boot in about
  30 s instead of about 175 s.
- Per-VM identity comes from cloud-init user data rendered by the platform as today
  (tokens, handle, registration token), plus the guest settings the spike proved:
  `ptp_kvm` and `phc2sys` for the clock after resume, the memory hotplug and page
  reporting kernel arguments, and swap.
- Guest kernel: direct boot of the pinned Ubuntu kernel shipped with the host release,
  with matching modules in the golden disk.
- Disk: 20 GiB thin volume for free owners (quota enforced by the volume size).

### 4. Memory

- Boot floor **2 GiB**, hotplug ceiling 8 GiB for free.
- **Paid owners never shrink and never sleep** (decided by Hamed): their memory only
  grows, up to their plan ceiling, and the controller does not reclaim it.
- A memory controller in the host agent, per VM, every few seconds: read guest pressure
  (PSI through a tiny guest endpoint or the balloon statistics), add virtio-mem blocks
  when pressure rises and the host has headroom, and when idle ask the guest to trim
  cache and compact, then shrink back toward the floor.
- Free page reporting at order 5. No KSM at launch (cross-tenant side channel); revisit
  with measurements.
- Host safety valve: zswap plus NVMe swap on the host, and a host-level rule that
  suspends the least recently active VMs before the kernel OOM killer runs.

### 5. Sleep and wake

- **Sleep** (free owners only): after **1 hour with no owner interaction** (no proxied
  owner requests, no attached terminal), the platform asks the host agent to suspend. A
  running agent turn or routine, reported by the gateway, may delay sleep by **at most 1
  more hour**; it can never keep a VM awake indefinitely. Both durations are platform
  configuration (decided by Hamed: 1 to 2 hours; launch at 1 hour). The host agent trims,
  waits for page reporting, snapshots, and stops the VM. Sleep takes about 8 to 11 s;
  the owner does not wait for it.
- **Snapshot storage** lives in the host's data pool, never the root filesystem, with
  free-space admission before each snapshot. A snapshot that fails leaves the VM running
  and reports the failure; the VM is only stopped after a snapshot is confirmed written
  (the S7 density run lost 18 VMs' state by snapshotting onto a full root disk).
- **Wake on request**: the host ingress receives a request for a sleeping VM, the host
  agent restores it on demand (`memory_restore_mode=ondemand`), and the request is
  forwarded once the gateway answers (about 1 s). The platform shows the existing boot
  page if waking takes longer than 3 s.
- **Scheduled wake**: on sleep, the gateway reports its next scheduled time (cron,
  routines, background agents). The platform wakes the VM then; it goes back to sleep
  when the gateway reports the work finished, or after a hard 30 minutes.
- **Channels** (Telegram and other bridges): inbound messages need a running process.
  Free owners' channels poll on scheduled wakes (proposed: every 15 minutes); paid owners
  stay awake.
- **No awake-hours cap** at launch (decided by Hamed). Spec 2691's D3 compute cap (80
  hours a month) is withdrawn. Abuse is bounded by the idle rule, CPU quota, and the
  section 6 egress controls; a cap can be added later from measured abuse.

### 6. Networking and routing

- Each VM has a private address on its host. No public address per VM.
- **Ingress**: each host runs a proxy on 443 with a real certificate for its host name.
  It routes by the `host` header the platform already sends (`<handle>.matrix-os.com`)
  to the VM's private address, after checking the platform verification headers
  (`x-platform-verified`, bearer). The VM keeps its existing nginx and auth.
- Platform routing: `profile-routing.ts` resolves `https://<host address>:443` for metal
  machines instead of the VM's own IPv4, through the substrate's `resolveUpstream`. The
  platform verifies the host certificate (unlike today's VPS TLS, TODO #410).
- **Egress**: NAT through the host. Free VMs: outbound port 25 blocked, per-VM bandwidth
  and connection-rate limits, and an alert plus automatic throttle on sustained
  high-CPU or high-packet-rate patterns typical of mining and scanning.

### 7. Platform changes

- Data: add a provider column to `user_machines` (`hetzner` or `metal`), a provider
  server id as text, and the host id; keep the Hetzner columns for Hetzner rows.
- Provider abstraction: generalize `HetznerClient` use behind a machine-provider
  interface (create, delete, power, resize memory, list, snapshot image) with Hetzner and
  Metal implementations; the deletion queue, reconciler, recovery, and resize go through
  it.
- Substrate: implement spec 2691 Stack A's `RuntimeSubstrate` with `startsOnDemand =
  true` for metal: `resolveUpstream`, `ensureRunning`, `stop`, `destroyCompute`,
  `listCompute`.
- Registration: `/vps/register` accepts a provider-neutral server id and no public IPv4
  for metal machines; the same token, bundle, and health checks apply.
- Placement: pick the host with the most memory headroom under a per-host admission
  ceiling; refuse with a "busy" state when every host is full (spec 2691 C3 global
  ceiling).

### 8. Durability and recovery

- Source of truth: the VM disk on RAID1, backed up by the bundle's existing hourly
  Postgres dump and home mirror to R2. RPO: one hour for the database, near-continuous
  for files.
- Host loss: the platform marks the host's machines `recovering` and recreates each on
  another host from the golden disk; `matrix-restore` brings back the owner data, the
  same path Hetzner recovery uses.
- Host maintenance: suspend every VM, patch and reboot, resume. Snapshots survive the
  reboot. Expected downtime per owner is one wake.
- A sleeping VM's snapshot plus disk is the full state; nothing lives only in memory
  beyond what a crash would lose on a VPS.
- **Moving a free VM to another host** (to make room for a paid owner's growth, or to
  rebalance): suspend, copy the snapshot and thin disk over the hosts' private network
  (25 Gbps), resume on the target, update the platform's host record by compare-and-set
  on the machine generation, then delete the source copy. An awake VM is moved at its
  next sleep unless the source host is under memory pressure. Paid VMs are not moved
  automatically.

### 9. Free plan and limits

From spec 2691, unchanged in intent: free entitlement without a card, invite gate first,
global capacity ceiling, funded Matrix AI with a starter credit and a hard spend ceiling,
storage quota. Proposed free limits: 2 to 8 GiB memory, 2 vCPU with a sustained quota,
20 GiB disk, sleep after 1 hour idle, no awake-hours cap.

### 10. What happens to the rest of spec 2691

| Stack | Fate |
| --- | --- |
| A Substrate model | Kept; the substrate kinds become `vps` (Hetzner, always on) and `metal` (on-demand). |
| B Container runtime profile | Dropped for the free tier. Items that also help VPSes (template ordering fix, `VACUUM INTO` snapshot, prebuilt JS) are kept as VPS improvements. |
| C Container substrate | Replaced by the host agent and Metal provider. The branch `feat/2691-container-register` is superseded. |
| D Clients | Kept and smaller: waking, busy, limit, failed states; no capability gating by plan. |
| E Upgrade | Reduced to a policy change on the same VM (decided by Hamed): sleep off, shrink off, higher memory ceiling, plan record. If the host lacks headroom, free VMs are moved off it first. |
| F Rollout | Kept: AGENTS.md amendment, runbook, internal then invite then open. |

## Delivery order

1. **Host platform**: host provisioning script, `matrix-hostd` (lifecycle, memory
   controller, ingress, golden disks), tests against a real host.
2. **Platform provider and substrate**: DB migration, provider interface, Metal provider,
   substrate, registration, routing, reconciler.
3. **Sleep and wake**: activity and next-schedule endpoints in the gateway, idle policy,
   wake on request, scheduled wakes, suspend-copy-resume moves between hosts, waking
   state in every surface.
4. **Free plan**: entitlement, signup, capacity ceiling, funded AI and quotas, abuse
   controls.
5. **Operations and rollout**: second host, monitoring and alerts, backup restore drill,
   density load test, runbooks; then internal, invite, open.

Each step is a native GitHub stack sharing one ticket, within the size limits.

## Decided by Hamed

- Free tier is full Matrix, small and sleeping.
- 2 GiB boot floor.
- Bare-metal hosts on Scaleway (EM-I620E chosen and ordered for the spike).
- An owner who upgrades stays on the same VM on our hosts; paid VMs never shrink or
  sleep; free VMs may be moved to other hosts to make room.
- No awake-hours cap at launch; idle free VMs sleep after 1 to 2 hours (launch at 1).

## Calls made after review (Claude's, for Hamed to check)

1. **Trust and egress.** "Full Matrix" means free owners get open internet egress and the
   same guest access a VPS owner has. Spec 2691's registry mirror, egress token, brokered
   web tools, and decisions D5 and D9 are withdrawn for the free tier. Abuse is handled by
   the controls in section 6 plus host-measured detection, not by a sandbox.
2. **Who decides awake time.** The platform, never the guest. The host agent measures
   awake time from VM run state for metering and abuse signals. The guest's "busy" report
   can delay sleep by at most the bounded extra hour in section 5, and can end a scheduled
   wake early, never extend it past 30 minutes.
3. **Who may wake a VM.** Only the platform, through the substrate's `ensureRunning`
   (authenticated owner request, or a scheduled wake the platform approved against the
   ledger). The host ingress never wakes a VM by itself; for a sleeping VM it returns a
   "not running" response the platform turns into a wake. Share links, collaborator
   views, and inbound webhooks to a sleeping free VM get "not available"; channels poll
   on scheduled wakes.
4. **Long-asleep VMs and disk.** A free VM asleep for 30 days is archived: its data is
   already in R2 (hourly Postgres dump and home mirror); the host deletes the snapshot
   and disk, and the next visit recreates it from the golden disk and restores (minutes,
   behind the boot page). Spec 2691's D3 retention (90 days, 30 days' notice) still
   decides when archived data is deleted. The thin pool may be overcommitted: alert at 70
   percent used, stop admitting new VMs at 80 percent, archive the oldest sleepers first.
5. **Snapshots across upgrades.** Each snapshot records the Cloud Hypervisor version and
   guest kernel it was taken with. Hosts keep every Cloud Hypervisor binary that still has
   snapshots (they are static binaries) and restore with the matching one. A host upgrade
   suspends, upgrades, and resumes with the old binary; the VM moves to the new binary at
   its next cold boot. Bundle updates, including security releases, are applied by the
   guest's existing passive update on wake, as on a VPS.
6. **Failover headroom.** Admission is limited by awake memory, not by owner count, and
   no host keeps 50 percent spare. On host loss, the survivor recreates the lost owners'
   disks and restores them from R2 in the background; owners who visit before theirs is
   done see the recovering state. Most owners are asleep, so awake memory is not the
   bottleneck; disk and restore throughput are, and the restore drill measures them.
7. **Spec rewrite.** After approval, `spec.md`, `plan.md`, and `tasks.md` are revised to
   this design (D1, FR-005 to FR-010, FR-020 to FR-022, limits, success criteria). Stack B
   items kept as VPS improvements are listed explicitly; `feat/2691-container-register`
   is closed as superseded.

## Left to the builder

- Host-agent implementation language and internal storage, within the repo's stack rules.
- Exact memory controller thresholds and intervals, tuned on the load test.
- Ingress proxy choice (nginx or a small Node or Go proxy), as long as it enforces the
  platform verification headers and per-VM routing.
- Golden disk build pipeline details, reusing the existing golden snapshot scripts.
