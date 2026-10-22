# AI credit and managed-model closeout

Tracks: [ENG-296](https://linear.app/matrix-os/issue/ENG-296), existing AI Gateway billing work. Requester approved one task and one implementation PR on 22 October 2026. Base: `69a06f252298c4f20e5ef207d125ae8e8da226dc`.

## Outcome and limits

Preserve the existing $5/$10/$25 purchase, signed webhook and ledger implementations. Diagnose the authoritative disabled-purchase projection, cover checkout through receipt/balance refresh, and avoid charging through unusable routes. Add an explicit, default-off subscription-credit policy and replay-safe grant foundation without inventing plan amounts, cadence, expiry or upgrade rules. Separate fixed operator spending caps from credit-backed budgets so a configured credit-backed runtime can spend legitimate new credit without remaining at its original $5 starter cap.

Eight Workers models already shipped in PR #2628. Reuse that registry, bounds, exact prices and harness adapters; regression-test their interaction with purchase eligibility. Production activation remains a separate operation.

Requester clarification: the already-merged Relay changes can share one clean-main Relay release, independently of this unfinished billing PR. The production-source-to-main diff includes #2579 (bounded slow readiness), #2628 (eight models), #2807 (terminal funded execution release) and #2831 (bounded shutdown/candidate route preservation). Never build that release from this dirty financial-feature worktree. The other Gateway verification task owns its existing release/acceptance work; this task neither dispatches nor changes it. Bundling eight-model code does not attest prices or broaden model policy.

## Implementation sequence (TDD)

1. Reproduce the screenshot from `topUpEnabled=false`; cover missing/partial checkout configuration independently of policy, health and client authority. Run existing signed-webhook, duplicate, refund/dispute and refresh regressions. Fix only demonstrated defects; preserve disabled production switches.
2. Add explicit `fixed` / `credit_backed` runtime budget policy with a backward-compatible default of fixed. New automatically created starter policies use credit-backed accounting. Credit grants align that mode's cap atomically to current-month settled spend plus real net credit, retaining reservations, debt/shortfall, source restrictions and exact policy revisions. Existing intentional fixed caps and historical policies remain unchanged until reviewed migration.
3. Implement bounded validated subscription policy configuration and an owner/cycle-idempotent grant service using the existing promotional ledger. Default disabled. Configuration must state each included plan's amount, `once` or `calendar_month` cadence and `never` or `cycle_end` expiry. These are supported configuration choices, not approved product rules; no plan amount or schedule is installed. The issuer currently has no automatic webhook, request-read or scheduler caller. Product confirmation must settle plan mapping, calendar vs billing-cycle timing, annual billing, starter overlap, upgrade/downgrade differences, proration, cancellation and effective-date behavior before wiring activation. Conflicting same-cycle terms fail closed instead of minting a refill.
4. Exercise shared eight-model policies, checkout with one healthy route, model-specific bounds and failure isolation using local transports only. Preserve independent price, allowlist, host compatibility and probe-budget release gates.
5. Run focused tests, relevant Platform/contracts/UI/relay regressions, type checks and pattern scans. Record any baseline/environment failures by name. Prepare a draft Conventional Commit PR with invariants, evidence boundaries and exact deployment prerequisites. Public documentation changes belong in a separate `FinnaAI/matrix-os-site` PR after product rules are confirmed; no website changes or production claims are bundled here.

## Transactions and authority

Existing owner-authenticated checkout and signed Stripe webhook routes retain their auth/body limits. No new public endpoints. Grants, balance updates and credit-backed budget changes share the existing transaction and owner/machine locks. Stable grant IDs use owner and approved entitlement cycle, never webhook delivery ID. Conflicts fail closed. Subscription configuration cannot enable model policies, rotate credentials or bypass readiness. Fixed policies remain an explicit independent ceiling.

## Validation and release boundary

Review corrections: promotion handoffs align both runtimes; refund and dispute restoration align the same transaction. Monetary reconciliation resolves the claim owner before billing/funded owner locks and rereads the claim under lock, including during pending deletion. Credential issuance and pre-upstream release acquire funded-owner serialization before rows. Effective funding/admission budgets derive after current-month rollover and expiry; checkout projections remain read-only. The schema revision advances to generation 22 with its source fingerprint. Native PostgreSQL ordering regressions must run in CI; local fallback fixtures cannot establish real contention.

No live Runtime/Browser instance or GUI operations, real payments, paid model calls, Slack, credit grants, credential/resource creation, production configuration, deployment or traffic changes. UI component tests are not live screenshots. Production global/runtime policies, pinned daily probe counters and exact host versions require a separately authorized read/rollout packet.

Rollback: disable new grant issuance and remove new model policy entries first. Preserve every existing ledger entry, reservation and admitted pricing version. Do not roll back to code unable to settle newly admitted pricing versions. Pending or unknown usage stays fail-closed.

Existing runtime policies migrate to `fixed`; do not infer that a historical $5 cap was accidental. A reviewed existing runtime can adopt `credit_backed` via the existing revisioned operator policy route, which aligns existing balances atomically without issuing credit. New auto-created starter policies use this mode. The theoretical cap is current-month settled spend plus nonnegative real credit net of shortfall; reservations continue reducing available balance and remaining budget. Ledger grants and mode changes share admission's owner lock before machine/policy/balance locks. Grant duplicates never raise caps again, and safe-integer overflow rolls the entire transaction back.
