# Spec 2727: free to paid upgrade for metal computers

**Status**: Draft for Hamed's review. **Ticket**: [ENG-606](https://linear.app/matrix-os/issue/ENG-606). **Builds on**: spec 2691 metal design (`specs/2691-runtime-substrates-free-tier/design-metal-vms.md`, branch `spec/2691-runtime-substrates-free-tier`, ENG-520), spec 2726 paid metal plans (PR #3809, ENG-605), free plan copy (PR #3811).

## Goal

A free owner upgrades their free metal computer to **Starter ($20)**, **Builder ($100)** or **Max ($200)** on the existing Stripe prices, from Settings > Billing. They keep their data and handle, are billed once, and end with exactly one computer. This spec defines the gate that re-enables the upgrade call to action hidden for free owners at launch.

## Non-goals

- New Stripe products, prices, or plan names.
- Live migration, or moving existing Hetzner owners to metal.
- Paid to paid plan changes (Builder to Max is spec 2726 journey 3).
- In-app purchase on Native Mobile.

## Placement decision

| Plan | Region chosen | Placement | When the preferred path is unavailable |
| --- | --- | --- | --- |
| Starter | EU | **Move to Hetzner `cpx22`** (2 vCPU, 4 GB, 80 GB) | none needed |
| Starter | US | Move to Hetzner `cpx22` in `ash`/`hil` | none needed |
| Builder | EU | **In place on metal**, Builder-metal shape (spec 2726) | Move to Hetzner `cpx42` |
| Max | EU | **In place on metal**, Max-metal shape (spec 2726) | Move to Hetzner `cpx52` |
| Builder/Max | US | Move to Hetzner `cpx42`/`cpx52` (no US metal) | none needed |

Why:
- **In place where a paid metal shape exists** (Hamed: "an owner who upgrades stays on the same VM"). No data copy, no read-only window, no routing change. Cost: one ~30 s cold restart, because the virtio-mem hotplug size and vCPU count are fixed at VMM start (spec 2726).
- **Starter moves.** Spec 2726 defines no Starter-metal shape. Paid metal disks are fully reserved and today's hosts are disk-bound (~2.6 TB admissible per EUR 600 host, ~EUR 0.23/GB/month), so an 80 GB Starter disk alone costs ~EUR 18 on metal, more than twice a `cpx22`. Revisit with a storage-rich host class (spec 2726 open question 4).
- **"Available"** means ENG-605's shapes and hostd changes (per-VM vCPUs, `reserveMiB`, disk growth, upgrade restart), the paid off-host backup, and a successful capacity hold are all live. Otherwise the owner moves to Hetzner, so ENG-606 can ship before ENG-605.
- **Shape shown before paying.** The hold decides placement; the plan card shows vCPU, memory and disk before Checkout, because Builder on Hetzner (16 GB) and on metal (64 GiB ceiling) differ at the same price.

## Journey (all surfaces)

| Surface | Upgrade call to action | Progress and result |
| --- | --- | --- |
| Web Desktop, Web Canvas | Settings > Billing > Free plan panel: plan cards, then Stripe Checkout | Upgrade status card plus a shell toast |
| Electron Desktop | Same panel. Checkout opens through the existing external-URL handler, and the panel polls `/billing/checkout/status` | Same status card |
| Web Mobile | Same panel (`allowsExternalPurchaseLinks()` is true on the web build) | Same status card |
| Native Mobile | **None.** The store purchase policy (`docs/dev/mobile-shell.md`, Guideline 3.1.3(f)) allows read-only plan status only | Read-only status: "Restarting your computer", "Moving your computer", "Upgraded to Builder". No price or plan links |

Steps:
1. **Pick** a plan (and region). The platform places a **capacity hold** and shows the resulting shape.
2. **Pay.** `POST /billing/checkout` with `mode: "upgrade"` opens Stripe Checkout through the existing attempt machinery (idempotency key = attempt id). No card trial for upgraders (open question 2).
3. **Provision or resize**, only after the verified `checkout.session.completed` webhook. In place: hostd raises the policy and grows the disk, then "Restarting your computer (about 30 s)" once agent runs settle or after 10 min ("Restart now" skips the wait). Move: build and warm-sync the target, then a short read-only window for the final sync and switch.
4. **Done.** New plan shown, sleep off, free-plan copy gone everywhere.

All surfaces render one shared `UpgradeStatus` contract (`packages/contracts`) through shared derivations.

## Capacity hold, then checkout, then the machine

- **Hold**: an `upgrade_holds` row (30 min TTL, swept every minute). In place, hostd reserves the plan's `reserveMiB` and vCPUs under its allocation lock (spec 2726 checks); without headroom, free VMs move off first, then this VM moves while still free; failing that, the hold falls back to Hetzner and shows the new shape. Hetzner holds record region and server type; a failed create retries the next location in the region.
- **No charge without a machine.** Checkout opens only with a live hold; the webhook renews an expired hold or falls back to Hetzner. Not `verified` by the deadline (30 min in place, 2 h move): page support, keep the free VM writable, and apply the existing refund path (refund the first invoice, cancel the subscription). No new billing mechanism.
- **Prebilling reuse (move)**: while Checkout is open, the existing prebilling intent may build the target on a staged row; `cleanupExpiredPrebillingCheckout` deletes it on expiry. The final sync waits for payment.
- **Today's gap**: `POST /billing/checkout` has no free-owner branch, and `findExistingProvisioningMachine` returns the running free metal row as `existing`, so a free owner who pays today keeps the free policy. Upgrade mode replaces this explicitly.

## Data move (cross-host upgrades only)

**Copied**:

| Data | How |
| --- | --- |
| Owner Postgres | Final `matrix-db-backup` dump to an upgrade-scoped R2 key; target runs `matrix-restore.sh` on that exact dump |
| Owner home (`/home/matrix/home`): files, apps and builds, projects, worktrees, bots, `.hermes`, terminal tab metadata | Sync-agent home mirror; the final flush ends at a barrier with one manifest generation, which the target hydrates exactly |
| Kernel `system/matrix.db` | `VACUUM INTO` copy from a read-only connection (spec 2691), restored before the gateway opens it |
| Messaging bridges | `matrix-messaging-backup`, then `matrix-messaging-restore` |
| Secrets outside home: `~/.ssh`, `~/.config/gh`, agent CLI auth | Allowlisted dotfile bundle, encrypted per upgrade, deleted after verification (open question 3) |
| Developer tools | Reinstalled from recorded tool ids |
| Funded-AI balances | Moved in the switch transaction; no second starter grant |

**Not copied**: running processes, Zellij sessions and scrollback (tabs are recreated), owner-installed `apt` packages (stated before paying), memory snapshots, and platform-issued tokens (the target gets new ones; old ones are revoked at the switch).

**Sequence** (a resumable state machine on the `free_upgrades` row; every transition is a compare-and-set on `state` and `generation`):
`held -> paid -> target_building -> warm_synced -> read_only -> final_synced -> restored -> verified_target -> switched -> verified -> source_retired`

- **Warm sync**: the target restores the latest hourly dump and home mirror while the owner works.
- **Read-only window** (`read_only` to `switched`, target < 5 min for a full 40 GiB free disk): the free VM goes `quiescing`; the gateway refuses new runs and writes; runs settle or are canceled at 10 min; terminals detach with a "moving" notice; then the final dump and flush. Reads, downloads and export keep working.
- **Verify before switching**: identical inventory on both machines (row counts per table, manifest hash per home root, apps with build status, tool ids, bridge state) and gateway health.

## Cutover and routing

Routing is already DNS-free: session routing on `app.matrix-os.com` and `/vm/<handle>` resolve the active `user_machines` row.

- **One transaction** under the owner lock and funding advisory lock: source row to `upgrade_source` (out of the active index), staged target (spec 2691 D10) promoted into the `(clerk_user_id, runtime_slot)` slot with the same handle, balances moved, generation bumped.
- **After commit**: the proxy drops its upstream cache; WebSockets close with a `moved` code; clients reconnect through existing waking states onto the target.
- **In place**: no switch; only `tier` changes in `user_machines` and hostd.

## Rollback

| When | What happens |
| --- | --- |
| Before `switched` | Drop the target (Hetzner deletion queue or hostd destroy), lift read-only on the free VM, release the hold, refund if paid. The owner keeps working on the free VM with no data loss |
| After `switched`, before `verified` (24 h watch) | Operator-only reverse switch. Writes made on the target since the switch are exported first, and the move fails closed if that export fails |
| In place, restart fails | hostd restarts with the previous VMM configuration. The policy row stays `paid`, and the runner retries or pages. Disk growth happens before the restart and is never undone |

## Releasing the free slot

- **After a verified move**: the free VM is suspended, never woken, and kept for **7 days**. Then it goes to `enqueueMetalVmDeletion` (reason `upgraded`). Its snapshot and thin volume are released, and the free-plan global capacity counter is decremented.
- **In place**: the free capacity counter is decremented at `verified`. The VM stays.
- **Free entitlement**: replaced by the paid entitlement in the switch transaction.

## Sleep on paid

- In place: hostd `PUT /v1/vms/:id/policy` with `tier: "paid"` makes the memory controller stop shrinking the VM. The sleeper skips paid rows. Scheduled-wake polling for channels stops, because bridges stay connected.
- During a move: the sleeper skips any owner with an open `free_upgrades` row, so the source never sleeps mid-sync.
- Hetzner targets never sleep.

## Downgrade and cancel

- **Cancel**: existing grace and billing suspension (`changeMetalBillingState` on metal, Hetzner suspension otherwise).
- **Paid to free**: only after every paid right ends (former-paid-owner rule) and free capacity is not `busy`. A metal VM with a 40 GiB disk goes back to `free` (sleep on, 8 GiB ceiling at next restart). **Disks never shrink**, so a larger disk or a Hetzner source gets a new free VM from the golden disk plus R2 restore, if home plus dump fit (~20 GiB after golden and headroom). Otherwise the paid machine stays read-only with export for 30 days, then deletion after retention notice (shared with spec 2726 open question 3).

## Concurrency

- **One active upgrade per owner**: a partial unique index on `free_upgrades(clerk_user_id) WHERE state NOT IN ('source_retired','abandoned')`, inserted with `ON CONFLICT DO NOTHING`, then the existing row is selected.
- **Double clicks, two devices**: `claimCheckoutAttempt` returns the same open Checkout URL for the same selection; a different one gets `409 checkout_pending` or the existing mismatch replacement. Holds are keyed by attempt. Free provisioning already answers `checkout_pending`.
- **Webhooks**: the `billing_webhook_events` insert-once gate covers redelivery; compare-and-set transitions make a replayed `checkout.session.completed` a no-op.
- **Runner**: leased and resumable; each step is idempotent by upgrade id plus generation (hostd by machine id plus generation, Hetzner create by label lookup).

## Security architecture

| Route | Caller | Auth |
| --- | --- | --- |
| `POST /billing/upgrade/hold`, `POST /billing/checkout` (`mode: "upgrade"`) | Signed-in owner (web surfaces) | Clerk session. Owner taken from the session, never from the body |
| `GET /billing/upgrade/status` | Owner, every surface including Native Mobile | Clerk session or the existing mobile token. Read-only |
| `POST /billing/upgrade/restart-now` | Owner | Clerk session, plus the upgrade must belong to the owner and be in `awaiting_restart` |
| `POST /billing/webhooks/stripe` | Stripe | Signature check (existing) |
| `POST /internal/upgrades/:id/rollback` | Operator | Platform bearer plus an admin Clerk session |
| hostd policy and destroy calls | Platform | mTLS plus per-host bearer (existing) |
| Gateway `quiesce` and `upgrade-export` | Platform | `UPGRADE_TOKEN` plus `x-platform-verified` (existing VPS auth) |

- **Input validation**:
  - Hono `bodyLimit` on every mutating route, including DELETE.
  - Strict Zod schemas: `planSlug` enum, `regionSlug` enum, `mode` literal, upgrade id as a UUID path param. `returnPath` goes through `resolveReturnPath`.
  - The dotfile bundle uses an allowlist of paths resolved with `resolveWithinPrefix`, skips symlinks (`lstat`), has a size cap (256 MiB), and rejects device and special files.
- **Error policy**: generic codes only (`capacity_unavailable`, `checkout_pending`, `upgrade_in_progress`, `upgrade_failed`, `unavailable`); provider, hostd, Stripe and Postgres errors, hosts and paths are logged server-side. Native Mobile never receives a price, URL or purchase copy.
- **Secrets**: per-upgrade dotfile bundle key, deleted with the bundle; old machine tokens revoked at the switch; the suspended source cannot accept writes.

## Failure modes

| Failure | Handling |
| --- | --- |
| Hold fails | Hetzner fallback is shown before checkout. Nothing is charged |
| Paid, but the hold expired or the host filled up | Renew the hold or fall back to Hetzner. If the deadline is missed, the free VM stays writable and the payment is refunded |
| Hetzner create fails or times out | Retry the next location (bounded at 3 attempts), then refund |
| Final dump or flush fails | Stay `read_only` for at most 15 min while retrying, then roll back to writable on the free VM |
| Inventory mismatch | No switch. Roll back and page |
| Platform crash mid-run | The lease expires and another worker resumes from the compare-and-set state |
| Switch transaction fails | Nothing moved. Retry. The source is still read-only and inside its deadline |
| Webhook delayed | "Confirming payment"; the status route checks the session via the existing settling-attempt logic |
| Restart in place hangs | 5-minute timeout, restart with the previous configuration, page |
| Account deletion mid-upgrade | The owner lock refuses new steps; the runner aborts and refunds; both machines follow deletion |

## Resource management

- Holds: 30 min TTL, swept every minute. One open upgrade per owner; at most 5 concurrent moves fleet-wide and 2 per metal host (configurable).
- Upgrade-scoped R2 objects are deleted at `verified`; a daily sweep removes orphans older than 7 days.
- Every external call has `AbortSignal.timeout` (10 s APIs, 30 s downloads, existing hostd timeouts). No upgrade state lives in memory.

## Re-enabling the call to action

The PR #3811 panel swaps "See paid plans" for the in-app upgrade only when the `FREE_UPGRADE_ENABLED` flag is set **and** acceptance checks 1 to 6 pass on staging. In-place placement turns on separately, behind `METAL_PAID_UPGRADE_ENABLED`, once ENG-605's gates are live.

## Acceptance checks

1. On staging, a free owner with sample data (chats, files, two apps with data, a project worktree, a cron job, a bridge, `gh` auth) upgrades to **Starter (move)**, **Builder** and **Max (in place)**, and Builder with in place forced off. Each run: identical inventory, same handle and URLs, one subscription, one paid invoice, one active `user_machines` row.
2. A move has a read-only window under 5 min. An in-place upgrade has one restart under 60 s. Neither sleeps afterward.
3. Double-clicking, and upgrading from two browsers at once, produce one Checkout session and one upgrade.
4. Killing the runner at each state, then resuming, completes without duplicate machines or charges. Forcing a failure before the switch leaves the free VM writable and refunds the payment.
5. The free VM is deleted 7 days after a verified move, and the free capacity counter drops at `verified`.
6. Native Mobile shows upgrade progress with no purchase UI (jest test plus device capture). Web Desktop, Web Canvas, Electron Desktop and Web Mobile each have live captures of the full flow.
7. Paid to free with data under 20 GiB rebuilds a 40 GiB free VM from R2. With larger data, the owner gets read-only plus export.

## Risks

1. **Data left behind on a move**: state outside `MATRIX_HOME` and the allowlist (apt packages, custom services) is lost. Mitigation: pre-payment notice and an inventory of unknown top-level paths.
2. **Charge with no machine**: a failed move depends on the refund path every time; a miss becomes a chargeback. Test deadline alerts and refunds end to end.
3. **Read-only window overruns** (large home, slow R2, runs that never settle): bounded at 15 min, then rollback.
4. **Paid metal without proven backup**: gate in-place placement on spec 2726's restore drill.
5. **Same price, different machine**: Builder on Hetzner (16 GB) versus metal (64 GiB) invites disputes if the shape copy is unclear.

## Open questions for Hamed

1. Starter: a move to Hetzner `cpx22` (proposed, on cost), or a Starter-metal shape in place (no move, but disk-bound economics)?
2. Upgraders: charge immediately (proposed), or offer the Starter 14-day or 3-day card trial?
3. Copy owner dotfiles and secrets outside home (`~/.ssh`, `gh`, agent CLI auth) on a move (proposed), or require the owner to sign in again?
4. Source free VM retention after a move: 7 days (proposed) or shorter?
5. Paid to free with data over 40 GiB: rebuild when it fits and ask for an export otherwise (proposed, shared with spec 2726 open question 3), or keep the large disk while free?
6. When metal cannot hold Builder/Max, fall back to Hetzner automatically with the shape shown (proposed), or make the owner wait in a queue for metal?
