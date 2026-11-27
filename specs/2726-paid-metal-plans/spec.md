# Spec 2726: paid Builder and Max plans on metal VMs

**Status**: Draft for Hamed's review. **Ticket**: [ENG-605](https://linear.app/matrix-os/issue/ENG-605). **Builds on**: spec 2691 metal design (`specs/2691-runtime-substrates-free-tier/design-metal-vms.md`, ENG-520), `docs/dev/metal-hosts.md`.

## Goal

Sell the existing **Builder ($100/mo)** and **Max ($200/mo)** plans as Matrix metal VMs with **64 GiB** and **128 GiB** memory ceilings, on the existing Stripe prices (no new Stripe products or prices). Use the same shapes for engineers' dev machines through the existing `internal` plan. Add, provision, and register new Scaleway bare-metal hosts through Scaleway's API when capacity runs low, with a human approval before any spend.

## Non-goals

- Moving existing Hetzner paid owners onto metal (separate decision and migration).
- Live migration. Moves stay suspend, copy, resume (spec 2691 section 8).
- New Stripe products, prices, or plan names. Starter stays on Hetzner for now.
- US metal: Scaleway Elastic Metal has no US zones, so US Builder/Max stay on Hetzner `ash`/`hil`.
- Automated host deletion. Retiring a host deletes data and stops spend, so a person does it.

## Affected surfaces

| Surface (planned for implementation PRs) | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Web Desktop | planned | planned | planned | planned | planned |
| Electron Desktop | planned | planned | planned | planned | planned |
| Web Canvas | planned | planned | planned | planned | planned |
| Web Mobile | planned | planned | planned | planned | planned |
| Native Mobile | planned | planned | planned | planned | planned |

Changes visible to owners: plan cards and Settings > Billing show the metal shape (vCPU, memory, disk) from `billing-catalog.ts` for EU Builder/Max; the upgrade flow (free to paid, Builder to Max) shows a short "restarting your computer" state for the single cold restart it needs; busy/no-capacity copy reuses the spec 2691 client states. No new screens. Implementation PRs carry the evidence; this spec PR is docs-only.

## Journeys

1. **New Builder/Max on metal (EU).** The owner picks Builder or Max and an EU location, pays on the existing Stripe price, and the platform reserves capacity **before** creating the Checkout Session (a placement hold with a 30 min TTL). After payment the metal provisioner creates a `paid` VM with the plan shape on the held host. If no metal host can hold it, the owner is offered the Hetzner shape (today's path) instead of waiting.
2. **Free to paid, in place on metal.** The VM stays on its host. hostd raises the memory ceiling (`PUT /v1/vms/:id/policy`), grows the thin LV (`lvextend`, guest `growpart` on boot), sets vCPUs, and turns sleep and shrink off. Raising the virtio-mem `hotplug_size` and the vCPU count needs a new VMM, so the upgrade ends with **one cold restart (~30 s)**, never a restore from the old snapshot. If the host lacks headroom, free VMs are moved off it first (spec 2691); if that is not enough, this VM is moved while it is still free (allowed), then upgraded.
3. **Builder to Max.** Same as 2 on the same host when it fits; otherwise a scheduled move during a window the owner accepts.
4. **Engineer internal machine.** An `internal` entitlement (billing override, no Stripe) provisions the Max-metal shape, never sleeps, is tagged `internal` in `user_machines`, counts against fleet capacity, and is capped by `METAL_INTERNAL_VM_LIMIT` (proposed 6).
5. **Downgrade Max to Builder.** Ceiling drops at period end: hostd shrinks the guest if it is above 64 GiB; if the shrink is refused, the old ceiling stays until the next restart. vCPUs change at that restart. Disks never shrink: the disk keeps its size (counted at full size) until a later restore into a smaller disk.
6. **Paid to free or cancel.** Existing grace and billing-suspension flow (`changeMetalBillingState`). Moving to free re-enables sleep and an 8 GiB ceiling at the next restart; the larger disk is kept for 30 days, then rebuilt at 40 GiB from backup only if usage fits, otherwise the owner is asked to export (open question 3).

## Proposed shapes

| Plan | vCPU | Boot memory | Ceiling | Guaranteed (admission reserve) | Disk | Sleeps |
| --- | --- | --- | --- | --- | --- | --- |
| Free (today) | 2 | 2 GiB | 8 GiB | 8 GiB while awake | 40 GiB | yes |
| **Builder-metal** | **16** | **8 GiB** | **64 GiB** | **32 GiB** | **320 GiB** | no |
| **Max-metal** | **32** | **16 GiB** | **128 GiB** | **64 GiB** | **480 GiB** | no |
| Internal | as Max | 16 GiB | 128 GiB | 64 GiB | 480 GiB | no |

Reasoning:
- **Memory** follows ENG-605 (64/128 GiB). Boot at 1/8 of the ceiling keeps cold restarts fast and lets page reporting keep host RSS near real use.
- **vCPU**: today's Hetzner Builder/Max are 8/12 shared vCPU. Metal doubles Builder and nearly triples Max so the plan is visibly better. Each host has 128 threads (EM-I620E: 64 cores, 128 threads). Paid vCPUs are not quota-capped; cgroup `CPUWeight` is proportional to plan, so contention is shared fairly instead of hard-limited.
- **Disk** matches today's Builder (320) and Max (480) so no paid owner gets less disk than on Hetzner. Disk, not memory, is the binding limit per host (see Storage), which is why it is not larger.
- **Guaranteed = 50% of ceiling** is the overcommit lever (next section).

## Overcommit policy

Today `memory-admission.ts` reserves the full ceiling plus 256 MiB per awake VMM, and the host keeps 32 GiB. That allows only four Max VMs per 534 GiB host. Proposed:

1. **Per-VM reserve.** Add `reserveMiB` to the hostd VM record and the create/policy requests. Admission counts `reserveMiB + 256 MiB` per awake VMM (free: `reserveMiB = maxMiB`, unchanged; paid: 50% of ceiling, never below boot).
2. **Per-host ceiling cap.** The sum of paid ceilings on a host must stay within `HOSTD_PAID_OVERCOMMIT_RATIO x budget`: launch at **1.25**, raise to 1.5 only after 30 days of RSS and pressure data. Both checks run in hostd's existing allocation lock.
3. **CPU cap.** Sum of paid vCPUs ≤ 2 x (host threads − 8).
4. **What makes it safe**: free page reporting (already in the guest cmdline) returns freed guest pages to the host even though paid VMs never shrink their virtio-mem size, so host RSS tracks real use. The 64 GiB host swap with zswap absorbs short spikes.
5. **Pressure ladder** (host `MemAvailable` and PSI, checked every few seconds):
   - Below 15% available: stop growing free VMs and stop admitting creates and wakes on this host.
   - Below 10%: suspend idle free VMs, least recently active first.
   - Below 5%: move awake free VMs off at their next sleep and page an operator.
   - Paid VMMs run with `OOMScoreAdjust=-500`, free with `+500`, so a kernel OOM never picks a paid VM before every free one.
   - A paid VM is never suspended or moved automatically for pressure.
6. **Host full**: placement skips it; the provisioner tries the next host, then the Hetzner fallback (journey 1). A host whose paid guarantees reach 90% of budget raises the capacity signal (Fleet automation).
7. **No live migration**: rebalancing a paid VM is a scheduled suspend, copy (480 GiB at 25 Gbps private network ≈ 3 min, plus memory), resume, with owner notice.

## Storage plan

- **Elastic Metal cannot attach Block Storage** (Scaleway FAQ), and the API's server options are only license, public bandwidth, private network, remote access, and certification; there is no disk option. "More storage per host" therefore means **choosing an offer with more drives**, not attaching volumes.
- Paid disks keep the current rule: **reserve the full virtual size** in the thin pool. A full pool hangs every guest, and paid VMs cannot be evicted, so paid disks are not overcommitted. Free disks keep the spec 2691 alert at 70% and refusal at 80–85%.
- Density on today's host class (EM-I620E, 2 x 3.84 TB RAID1, ~3.1 TB pool, ~2.6 TB admissible): for example 3 Max + 3 Builder = 2.4 TB disk, 576 GiB of ceilings (within 1.25 x 534), 288 GiB guaranteed. These hosts are disk-bound at about 6 paid VMs (~$900/mo of plan revenue against about EUR 600/mo for the host).
- **Paid host class.** Split hosts into `free` and `paid` classes (a column on `metal_hosts`). Upgraded VMs stay where they are; new paid VMs go to paid-class hosts first. Candidate for paid-class hosts: **EM-L630E-NVMe** (512 GiB, 32 cores/64 threads, 2 x 1.92 TB + 10 x 3.84 TB NVMe, fr-par-2 only; RAID10 on the 10 drives gives about 19 TB). Disk stops binding there, and memory and CPU decide density. Price is **unverified** (not shown in the docs; check the pricing page before ordering). Ordering one hourly for a 48 h benchmark is the cheap way to decide.
- Snapshots: paid VMs never sleep, so they use no snapshot space except during moves and maintenance.

## Backups and durability

- Free metal VMs have **no off-host backup** today; a host loss there means data loss. That is acceptable for free but not for paid.
- **Paid metal VMs must have off-host backup before launch**: the bundle's existing hourly Postgres dump and home mirror to R2 (as on Hetzner VPSes) is enabled for every `paid`/`internal` metal VM. In addition, hostd takes a daily crash-consistent thin snapshot of each paid disk and ships it incrementally (restic or equivalent) to R2 or Scaleway Object Storage, so a restore also brings back packages and the system state outside home. Proposed retention: 7 daily copies.
- RPO: 1 h for database and home files, 24 h for the full disk. RTO for one VM onto another host: minutes for home and database, longer for a full disk (measured in the restore drill).
- RAID1 (or RAID10) on every host. A failed drive is replaced through Scaleway support (documented software-RAID procedure).

## Host fleet automation

**Capacity signal** (platform worker, every 5 min, from `GET /v1/capacity` per host): per host class, free reserve memory, free ceiling room under the ratio, admissible thin-pool bytes, and free vCPU allowance. **Low** = the class cannot fit one more Max-metal plus one Builder-metal (N+1), or less than 20% headroom on any dimension, or the 7-day paid-signup trend reaches the limit within 14 days.

**Pipeline** (rows in a new `metal_host_orders` table; one order in flight at a time):

1. `proposed`: the worker writes the offer, zone, hourly estimate, and reason, and alerts Slack `#tech`.
2. `approved`: **Hamed (or an allowlisted admin) approves in person**: Clerk session plus admin allowlist, never a machine token. Approval checks the budget guardrails.
3. `ordering`: a GitHub Actions workflow in a protected environment (`metal-host-add.yml`) calls Scaleway `CreateServer` (offer, zone, `install` with OS id, hostname, SSH key ids, partitioning schema, `user_data` cloud-init that only installs Tailscale with a single-use pre-auth key; tag `matrix-order:<orderId>`). Idempotency: before creating, list servers by that tag.
4. `delivering`, then `installing`: poll `GetServer` until status `ready` and install `completed` (delivery takes minutes; install takes up to 1 h; timeout 3 h).
5. `provisioning`: over the tailnet, run `provision-host.sh --data-disks …`, install the host's TLS certificate (DNS record plus ACME), then `build-golden-disk.sh <current version>` and `smoke-host.sh`.
6. `registered`: the workflow calls the new admin route to upsert the `metal_hosts` row as **`draining`** (cannot admit).
7. `active`: after the smoke passes and an operator confirms the firewall (`--confirm-firewall`), the route sets `active`. Billing switches to monthly through `MigrateServerToMonthlyOffer` only after 7 days in service. It is one-way and charges a commitment fee of one month.

**Draining and retiring**: `draining` stops placement. Free VMs move at their next sleep; paid VMs move in scheduled windows with owner notice. When the host is empty, the status becomes `retired` (new enum value), and a person deletes the server in Scaleway. Billing runs until deletion, including while the server is powered off.

**Cost guardrails** (platform config, enforced at proposal and approval): `METAL_FLEET_MAX_HOSTS` (launch 4), `METAL_FLEET_MONTHLY_BUDGET_EUR` (sum of active plus ordered hosts at monthly price), at most one order in flight, a Scaleway billing alert set in the console, and Scaleway organization quotas as the last limit. Every order needs a human approval, per the global rule that spending money needs Hamed.

## Platform and hostd changes (summary)

- `billing-catalog.ts`: metal profiles for EU Builder/Max; Stripe prices unchanged.
- `metal-provisioner.ts`: per-plan shapes (`free`, `builder`, `max`, `internal`); placement by reserve and class cap, not `bootMiB`; capacity hold before checkout.
- hostd: per-VM `vcpus` (today a host-wide 2) and `reserveMiB`, ratio and CPU checks, OOM score by tier, disk growth on policy change, upgrade restart.
- `metal_hosts`: `host_class`, `retired`, `scaleway_server_id`, `zone`, `monthly_price_eur`; new `metal_host_orders`; admin routes plus `scripts/metal/fleet.ts`.
- Sleeper skips `internal` as it skips paid.

## Security architecture

**Credentials**
- Scaleway IAM: two API keys in one dedicated project.
- The **read-only key** (`ElasticMetalReadOnly`) lives in GCP Secret Manager for the platform worker's reconciliation.
- The **write key** (`ElasticMetalFullAccess`) is only a GitHub protected-environment secret used by the order workflow, behind a required reviewer. The platform never holds a key that can spend.
- Auth is the `X-Auth-Token` header; the keys are rotated every 90 days.
- Tailscale pre-auth keys are single-use and expire after 4 h. The hostd tokens stay in platform config (`METAL_HOSTD_API_TOKEN`; per-host tokens are a follow-up).

**Auth matrix**

| Route | Caller | Auth |
| --- | --- | --- |
| `GET /internal/metal-fleet/capacity` | operator CLI, worker | platform bearer (`PLATFORM_SECRET`) |
| `PUT /internal/metal-hosts/:id` (register, upsert as `draining`) | order workflow | platform bearer + workflow OIDC claim for the repo/environment |
| `POST /internal/metal-hosts/:id/status` (`active`, `draining`, `retired`) | operator | platform bearer + admin Clerk session |
| `POST /internal/metal-host-orders/:id/approve` | Hamed / allowlisted admin | admin Clerk session only |

**Input validation**
- Hono `bodyLimit` (16 KB) on every mutating route.
- Zod strict schemas: `MetalHostInputSchema` reused; the host id matches the existing safe regex; `apiUrl` must be `https`, and `ingressHost` must be under an allowlisted Matrix domain.
- Offer and zone come from an allowlist in config; status is an enum; path and query params are validated at the route.

**Error policy**
- Clients get generic codes (`capacity_unavailable`, `invalid_request`, `unavailable`).
- Scaleway errors, server ids, IPs, and paths are logged server-side only, never returned or posted to Slack beyond the order id.

## Failure modes

| Failure | Handling |
| --- | --- |
| Offer `out_of_stock` or stock `empty` | Order stays `approved`; the worker proposes an allowed alternate zone/offer and asks for approval again. |
| Delivery or install stuck or `error` | 3 h timeout marks the order `failed`, alerts, and leaves the server for a person to reinstall or delete (spend continues: the alert says so). |
| Provision, golden, or smoke fails | Host stays `draining`; the workflow is idempotent and can be rerun. |
| Duplicate order (workflow retry) | Tag lookup before `CreateServer`; unique order id in `metal_host_orders`. |
| Scaleway API down or rate-limited (429) | Exponential backoff with jitter; every call has `AbortSignal.timeout(10_000)`. Placement does not depend on Scaleway. |
| Checkout paid, but capacity hold lost | Provisioner retries other hosts, then the Hetzner fallback; the owner is never charged without a machine. |
| Paid upgrade, but no room after moving free VMs off | Upgrade queued with a "preparing" state; the entitlement is active, and the VM stays at its old shape until moved (bounded 24 h, then an operator is paged). |
| Host memory pressure | Pressure ladder; paid VMs last. |
| Host loss | Free: lost (no backup). Paid: recreate on another host from the golden disk plus R2 restore of home, database, and the daily disk image. |
| Concurrent register/status writes | Single upsert by id; status changes compare-and-set on `updated_at`. |

## Resource management

- One order in flight; order rows kept 1 year (small).
- Capacity probes are bounded (existing 2 s probe, concurrency cap).
- Placement holds expire after 30 min and are swept every minute.
- Disk backups: one in flight per host, I/O-limited by cgroup, 7 kept.
- Snapshot LVs for backup are deleted after upload, with a sweep at startup.
- Workflow job timeout 4 h.

## Acceptance checks

1. Staging: a Builder and a Max checkout on the existing test-mode prices provision metal VMs with 16/32 vCPU, 64/128 GiB ceilings, and 320/480 GiB disks; Settings > Billing shows those specs on all five surfaces.
2. A free VM upgraded to Builder keeps its data and handle, restarts once, and reports the new ceiling and disk; it no longer sleeps.
3. On a host filled to the ratio cap, a further paid placement goes to another host or to the Hetzner fallback; no checkout completes without a machine.
4. A memory-pressure test (paid VMs at their guarantee, free VMs awake) never OOM-kills or suspends a paid VMM.
5. Restore drill: delete a paid VM's disk on staging and restore it on another host from R2 within the stated RTO.
6. Fleet: forcing the capacity signal produces a proposal; after approval, the workflow orders (on staging, a small hourly offer), installs, provisions, registers as `draining`, smokes, and activates the host with no manual SSH steps beyond the firewall confirmation.
7. Guardrails: a proposal that would exceed `METAL_FLEET_MAX_HOSTS` or the budget is refused at approval.

## Risks

- **Overcommit realized**: paid owners who keep memory hot (large builds, many agents) erode the margin. Mitigations: ratio 1.25 at launch, RSS telemetry, raise only with data.
- **Single zone and provider**: all hosts in one Scaleway region; a regional outage takes paid metal down. The Hetzner fallback covers new signups only.
- **Disk-bound economics** on EM-I620E (~6 paid VMs per host) until a storage-rich paid class is proven.
- **Monthly commitment is one-way**: a host switched to monthly cannot go back to hourly.
- **No off-host backup for free** remains a known gap.
- **Hetzner dedicated as second provider** is viable later (Robot ordering API, see Research notes) but needs its own install path.

## Research notes (Scaleway, read-only)

- **API** ([SDK baremetal v1](https://github.com/scaleway/scaleway-sdk-go/blob/master/api/baremetal/v1/baremetal_sdk.go), [reference](https://www.scaleway.com/en/developers/api/elastic-metal/)): `ListOffers` (stock, hourly/monthly, prices, fee), `CreateServer` (offer, zone, `install{os_id, hostname, ssh_key_ids, partitioning_schema}`, `option_ids`, `user_data` cloud-init), `GetServer`, `InstallServer`, `DeleteServer`, `MigrateServerToMonthlyOffer`. Zones fr-par-1/2, nl-ams-1/2, pl-waw-2/3. Cloud-init since [2025-10](https://github.com/scaleway/docs-content/blob/main/changelog/october2025/2025-10-31-elastic-metal-added-cloud-init-feature-available-on-ela.mdx); bulk API orders since [2025-09](https://github.com/scaleway/docs-content/blob/main/changelog/september2025/2025-09-22-elastic-metal-added-bulk-order-and-audit-trail-integrat.mdx).
- **Timing and billing** ([FAQ](https://www.scaleway.com/en/docs/elastic-metal/faq/), [billing period](https://www.scaleway.com/en/docs/elastic-metal/how-to/change-billing-period/), [billing FAQ](https://www.scaleway.com/en/docs/billing/faq/)): delivered in minutes, install up to 1 h; monthly costs a one-month commitment fee, hourly to monthly once, never back; billed from creation to deletion, powered off included. EM-I620E: EUR 599.99/mo or EUR 1.644/h ([Iridium](https://www.scaleway.com/en/elastic-metal/iridium/)).
- **Storage**: no Block Storage on Elastic Metal ([FAQ](https://www.scaleway.com/en/docs/elastic-metal/faq/)); back up to Object Storage; storage-rich offers in the [datasheet](https://www.scaleway.com/en/docs/elastic-metal/reference-content/elastic-metal-datasheet/).
- **Network**: Private Networks are a per-server billed option, 250 bare-metal resources per network ([how-to](https://www.scaleway.com/en/docs/elastic-metal/how-to/use-private-networks/), [quotas](https://www.scaleway.com/en/docs/organizations-and-projects/organization/organization-quotas/)).
- **Auth**: IAM key in `X-Auth-Token`; `ElasticMetalReadOnly` / `ElasticMetalFullAccess` ([permission sets](https://www.scaleway.com/en/docs/iam/reference-content/permission-sets/)). No published Elastic Metal rate limit (unverified).
- **Hetzner fallback** ([Robot webservice](https://robot.hetzner.com/doc/webservice/en.html)): `POST /order/server/transaction` and `/order/server_market/transaction`, 20 order POSTs per day, a `test` flag, ordering enabled in Robot settings first, no cloud-init at order time.

## Open questions for Hamed

1. Should new EU Builder/Max default to metal (Hetzner as fallback), or be offered side by side? Do US plans stay Hetzner-only?
2. Overcommit: is a 50% guarantee plus a 1.25 ceiling ratio "light" enough, or should paid VMs also shrink when idle (this reverses "paid never shrink")?
3. Paid to free with a disk over 40 GiB: rebuild from backup when it fits and ask for an export otherwise, or keep the larger disk while they are free?
4. Should the paid-class host be EM-L630E-NVMe (storage-rich, fewer threads, price unknown) or more EM-I620E (disk-bound)? Approve a 48 h hourly benchmark?
5. Should paid metal launch be gated on the daily full-disk backup, or is the R2 home and database backup enough for launch?
6. Fleet limits: max 4 hosts and what monthly budget? Is any approver besides you allowed?
7. Internal machines: Max shape for every engineer, and a cap of 6?
