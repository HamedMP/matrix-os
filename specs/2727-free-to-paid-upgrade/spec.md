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
- **In place is the default where a paid metal shape exists.** Hamed decided that "an owner who upgrades stays on the same VM". In place copies no data, needs no read-only window, and changes no routing. Its only cost is one cold restart of about 30 s, because the virtio-mem hotplug size and vCPU count are fixed when the VMM starts (spec 2726).
- **Starter moves to Hetzner.** Spec 2726 keeps Starter on Hetzner and defines no Starter-metal shape. Paid metal disks reserve their full size, and today's hosts run out of disk first: about 2.6 TB is admissible on an EUR 600 host, which is roughly EUR 0.23/GB/month. An 80 GB Starter disk alone costs about EUR 18 on metal. A `cpx22` costs less than half that. Revisit if a storage-rich paid host class lands (spec 2726 open question 4).
- **"Available" means three gates are all live:** ENG-605's shapes and hostd changes (per-VM vCPUs, `reserveMiB`, disk growth, upgrade restart), the paid off-host backup, and a capacity hold that succeeds. If any gate is missing, the upgrade moves the owner to Hetzner, so ENG-606 can ship before ENG-605.
- **The owner sees the result before paying.** The capacity hold decides the placement, and the plan card shows the exact shape (vCPU, memory, disk) before Checkout opens. A Builder on Hetzner (16 GB) and a Builder on metal (64 GiB ceiling) are different machines at the same price, so the owner never learns which one they got after paying.

## Journey (all surfaces)

| Surface | Upgrade call to action | Progress and result |
| --- | --- | --- |
| Web Desktop, Web Canvas | Settings > Billing > Free plan panel: plan cards, then Stripe Checkout | Upgrade status card plus a shell toast |
| Electron Desktop | Same panel. Checkout opens through the existing external-URL handler, and the panel polls `/billing/checkout/status` | Same status card |
| Web Mobile | Same panel (`allowsExternalPurchaseLinks()` is true on the web build) | Same status card |
| Native Mobile | **None.** The store purchase policy (`docs/dev/mobile-shell.md`, Guideline 3.1.3(f)) allows read-only plan status only | Read-only status: "Restarting your computer", "Moving your computer", "Upgraded to Builder". No price or plan links |

Steps:
1. **Pick.** The owner picks a plan (and a region, for a move). The platform places a **capacity hold** (below) and shows the resulting shape.
2. **Pay.** `POST /billing/checkout` with `mode: "upgrade"` opens Stripe Checkout on the existing price and attempt machinery. The idempotency key is the attempt id. Upgraders get no card trial: they have already used the free plan (open question 2).
3. **Provision or resize.** This starts only after the verified `checkout.session.completed` webhook, never on a client claim.
   - In place: hostd raises the policy and grows the disk. The owner sees "Restarting your computer (about 30 s)", which starts after in-flight agent runs settle or after 10 minutes. "Restart now" skips the wait.
   - Move: the target is built and warm-synced, then a short read-only window covers the final sync and the switch.
4. **Done.** The status card shows the new plan. Sleep is off. The free-plan copy disappears on every surface.

Every surface renders the progress states from one shared contract (`packages/contracts`, the `UpgradeStatus` enum) through shared derivations. No surface derives the state on its own.

## Capacity hold, then checkout, then the machine

- **Hold**: an `upgrade_holds` row created at step 1, with a 30-minute time to live, swept every minute.
  - In place: hostd reserves the plan's `reserveMiB` and vCPU allowance on the VM's host, under its allocation lock, using the spec 2726 reserve and ratio checks.
  - If the host has no headroom: spec 2726's order applies. First move free VMs off the host. If that is not enough, move this VM while it is still free.
  - If placement still fails, the hold falls back to Hetzner and the owner sees the new shape.
  - Hetzner: the hold records the region and server type. Hetzner capacity is not reserved ahead of time. A Hetzner create that fails is retried in the next allowed location of the same region.
- **No charge without a machine.**
  - Checkout opens only with a live hold. A hold that expires while Checkout is still open is renewed by the webhook, with a fallback to Hetzner if renewal fails.
  - If the upgrade is not `verified` by its deadline (30 min in place, 2 h for a move), the runner pages support, keeps or returns the free VM writable, and applies the existing refund path. That path is a full refund of the first invoice plus cancelation of the subscription. No new billing mechanism is introduced.
- **Prebilling reuse (move only)**: while Checkout is open, the existing prebilling intent may build the target VPS on a staged row. An expired or abandoned checkout deletes it through `cleanupExpiredPrebillingCheckout`. The final sync still waits for payment.
- **Today's gap**: `POST /billing/checkout` has no free-owner branch. `findExistingProvisioningMachine` returns the running free metal row as `existing`, so a free owner who pays today keeps the free policy. The upgrade mode replaces that path explicitly.

## Data move (cross-host upgrades only)

**Copied**:

| Data | How |
| --- | --- |
| Owner Postgres | Final `matrix-db-backup` dump to an upgrade-scoped R2 key, then `pg_restore --clean` on the target (the existing `matrix-restore.sh` path, pointed at that exact dump) |
| Owner home (`/home/matrix/home`): files, app sources and built `dist/`, projects, worktrees, bots, `.hermes`, shell preferences, terminal tab metadata | Sync-agent home mirror to R2. The final flush ends at a barrier with one manifest generation, and the target hydrates exactly that generation |
| Kernel `system/matrix.db` | `VACUUM INTO` copy from a read-only connection (spec 2691), restored before the gateway opens it |
| Messaging bridges | `matrix-messaging-backup`, then `matrix-messaging-restore` |
| Owner secrets outside home: `~/.ssh`, `~/.config/gh`, `~/.claude`, `~/.codex`, other agent CLI auth | A bounded, allowlisted dotfile bundle, encrypted with a per-upgrade key and stored under the owner's R2 prefix. Deleted after verification (open question 3) |
| Developer tools | Reinstalled on the target from the recorded tool ids, not copied |
| Funded-AI balances | Moved in the switch transaction under the per-owner funding lock. No second starter grant |

**Not copied**: running processes, Zellij sessions and scrollback (tabs are recreated in the same project workspaces), `apt` packages the owner installed (the owner is told before paying), memory snapshots, and platform-issued tokens. The target gets new registration, `UPGRADE_TOKEN`, and sync credentials, and the old ones are revoked at the switch.

**Sequence** (a resumable state machine on the `free_upgrades` row; every transition is a compare-and-set on `state` and `generation`):
`held -> paid -> target_building -> warm_synced -> read_only -> final_synced -> restored -> verified_target -> switched -> verified -> source_retired`

- **Warm sync**: the target restores the latest hourly dump and the home mirror while the owner keeps working.
- **Read-only window** (`read_only` through `switched`, target under 5 min for a full 40 GiB free disk):
  - The platform sets the free VM to `quiescing`. The gateway refuses new runs and writes, and agent runs settle or are canceled at a 10-minute deadline (each run's own outcome is kept).
  - Terminals detach with a "moving" notice. Then the final dump and flush run.
  - Reads, Files download, and export keep working.
- **Verification before the switch**: compare an inventory taken on both machines: row counts per table, a manifest hash per home root, the app list with build status, tool ids, and bridge state. Gateway health must pass.

## Cutover and routing

Routing is already DNS-free: session routing on `app.matrix-os.com` and `/vm/<handle>` resolve the active `user_machines` row.

- **The switch is one transaction** that takes the owner lock and the funding advisory lock:
  - set the source row to `upgrade_source` (out of the active index),
  - promote the staged target row (spec 2691 D10) into the `(clerk_user_id, runtime_slot)` slot with the same handle,
  - move balances,
  - bump the generation,
  - write the paid entitlement's machine link.
- **After the commit**: the proxy invalidates its upstream cache, and open WebSockets close with a `moved` code. Clients reconnect through the existing waking and reconnect states and land on the target.
- **In place**: there is no switch. The VM, row, and route stay the same, and only `tier` changes in `user_machines` and hostd.

## Rollback

| When | What happens |
| --- | --- |
| Before `switched` | Drop the target (Hetzner deletion queue or hostd destroy), lift read-only on the free VM, release the hold, refund if paid. The owner keeps working on the free VM with no data loss |
| After `switched`, before `verified` (24 h watch) | Operator-only reverse switch. Writes made on the target since the switch are exported first, and the move fails closed if that export fails |
| In place, restart fails | hostd restarts with the previous VMM configuration. The policy row stays `paid`, and the runner retries or pages. Disk growth happens before the restart and is never undone |

## Releasing the free slot

- **After a verified move**: the free VM is suspended, never woken, and kept for **7 days**. Then it goes to `enqueueMetalVmDeletion` (reason `upgraded`). Its snapshot and thin volume are released, and the free-plan global capacity counter is decremented.
- **In place**: the free capacity counter is decremented at `verified`. The VM stays.
- **Free entitlement**: replaced by the paid Stripe entitlement in the same transaction. `writeFreeEntitlement` already refuses to replace live paid rights.

## Sleep on paid

- In place: hostd `PUT /v1/vms/:id/policy` with `tier: "paid"` makes the memory controller stop shrinking the VM. The sleeper skips paid rows. Scheduled-wake polling for channels stops, because bridges stay connected.
- During a move: the sleeper skips any owner with an open `free_upgrades` row, so the source never sleeps mid-sync.
- Hetzner targets never sleep.

## Downgrade and cancel

- **Cancel**: the existing grace and billing-suspension flow applies (`changeMetalBillingState` on metal, and the existing Hetzner suspension).
- **Paid to free**: allowed only once every paid right has ended (the existing former-paid-owner rule), and only when free capacity is not `busy`.
  - Metal in place: tier goes back to `free`, sleep turns on, and the 8 GiB ceiling applies at the next restart. **The disk never shrinks.**
  - **Disk over 40 GiB, or a Hetzner source**: a new free VM is built from the golden disk and restored from R2. This works only when the owner's data fits (the restore preflight checks that the home and dump size is 40 GiB minus golden and headroom, about 20 GiB).
  - If it does not fit: the paid machine is kept read-only for 30 days with export and delete. The owner is asked to trim or export, then deletion follows retention notice. This matches spec 2726 open question 3 and needs one answer for both specs.

## Concurrency

- **One active upgrade per owner**: a partial unique index on `free_upgrades(clerk_user_id) WHERE state NOT IN ('source_retired','abandoned')`, inserted with `ON CONFLICT DO NOTHING`, then the existing row is selected.
- **Double clicks and two devices**: the existing `claimCheckoutAttempt` returns the same open Checkout URL for the same selection. A different selection gets `409 checkout_pending`, or the open attempt is replaced through the existing mismatch path. Holds are keyed by the attempt.
- **Free provisioning during checkout**: this already returns `checkout_pending`.
- **Webhooks**: the existing `billing_webhook_events` insert-once gate covers redelivery. Upgrade transitions are compare-and-set, so a replayed `checkout.session.completed` is a no-op.
- **Runner**: a leased worker that resumes after a crash. Each step is idempotent by upgrade id plus generation (hostd is idempotent by machine id plus generation, and the Hetzner create uses a label lookup).

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
- **Error policy**: clients get generic codes only (`capacity_unavailable`, `checkout_pending`, `upgrade_in_progress`, `upgrade_failed`, `unavailable`). Hetzner, hostd, Stripe, and Postgres errors, host names, and paths are logged server-side only. Native Mobile never receives a price, a URL, or purchase copy.
- **Secrets**:
  - The dotfile bundle key is per upgrade, held in platform config storage, and deleted with the bundle.
  - Old machine tokens are revoked at the switch.
  - The source VM is suspended with its tokens revoked, so a stale client cannot write to it.

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
| Webhook delayed | Status shows "Confirming payment". The status route also checks the checkout session through the existing settling-attempt logic |
| Restart in place hangs | 5-minute timeout, restart with the previous configuration, page |
| Owner deletes their account mid-upgrade | The account-deletion owner lock refuses new upgrade steps. The runner aborts, refunds, and both machines follow deletion |

## Resource management

- Holds have a 30 min time to live, with a sweeper every minute. At most one open upgrade per owner. At most 5 moves run at once fleet-wide, and at most 2 per metal host, all configurable.
- Upgrade-scoped R2 objects (final dump, dotfile bundle) are deleted at `verified`, with a daily sweep of orphans older than 7 days.
- Every external call has `AbortSignal.timeout`: 10 s for APIs, 30 s for downloads, and hostd timeouts as they are today.
- Staged target rows and holds are bounded by the unique index. In-memory registries hold no upgrade state.

## Re-enabling the call to action

The PR #3811 panel swaps "See paid plans" for the in-app upgrade only when the `FREE_UPGRADE_ENABLED` flag is set **and** acceptance checks 1 to 6 pass on staging. In-place placement turns on separately, behind `METAL_PAID_UPGRADE_ENABLED`, once ENG-605's gates are live.

## Acceptance checks

1. On staging, a free owner with sample data (chats, files, two apps with app data, a project with a worktree, a cron job, a connected bridge, and `gh` auth) upgrades to **Starter (move)**, **Builder (in place)** and **Max (in place)**, and also to Builder with in-place forced off (move). Each run produces a before and after inventory that is identical, keeps the same handle and URLs, creates one Stripe subscription and one paid invoice, and leaves one active `user_machines` row.
2. A move has a read-only window under 5 min. An in-place upgrade has one restart under 60 s. Neither sleeps afterward.
3. Double-clicking, and upgrading from two browsers at once, produce one Checkout session and one upgrade.
4. Killing the runner at each state, then resuming, completes without duplicate machines or charges. Forcing a failure before the switch leaves the free VM writable and refunds the payment.
5. The free VM is deleted 7 days after a verified move, and the free capacity counter drops at `verified`.
6. Native Mobile shows upgrade progress with no purchase UI (jest test plus device capture). Web Desktop, Web Canvas, Electron Desktop and Web Mobile each have live captures of the full flow.
7. Paid to free with data under 20 GiB rebuilds a 40 GiB free VM from R2. With larger data, the owner gets read-only plus export.

## Risks

1. **Data left behind on a move**: owner state outside `MATRIX_HOME` (apt packages, custom services, files in `/home/matrix` beyond the allowlist) is lost silently. Mitigations: pre-payment notice, an inventory of unknown top-level paths, and the allowlist.
2. **Charge with no machine**: a Stripe charge followed by a failed move relies on the refund path working every time. A missed refund is a support and chargeback incident. The deadline alerts and the refund must be tested end to end.
3. **Read-only window overruns**: a large home, slow R2, or runs that never settle stretch the window. The window is bounded at 15 min, then rolls back.
4. **Paid metal without proven backup**: in place puts a paying owner on a host whose off-host backup (spec 2726) is new. Gate in-place placement on the restore drill.
5. **Same price, different machine**: Builder on Hetzner (16 GB) versus metal (64 GiB) can cause disputes and support load, and the fallback chooses the substrate silently if the copy is unclear.

## Open questions for Hamed

1. Starter: a move to Hetzner `cpx22` (proposed, on cost), or a Starter-metal shape in place (no move, but disk-bound economics)?
2. Upgraders: charge immediately (proposed), or offer the Starter 14-day or 3-day card trial?
3. Copy owner dotfiles and secrets outside home (`~/.ssh`, `gh`, agent CLI auth) on a move (proposed), or require the owner to sign in again?
4. Source free VM retention after a move: 7 days (proposed) or shorter?
5. Paid to free with data over 40 GiB: rebuild when it fits and ask for an export otherwise (proposed, shared with spec 2726 open question 3), or keep the large disk while free?
6. When metal cannot hold Builder/Max, fall back to Hetzner automatically with the shape shown (proposed), or make the owner wait in a queue for metal?
