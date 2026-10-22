# Funded credit closeout

Tracks [ENG-182](https://linear.app/matrix-os/issue/ENG-182), [ENG-22](https://linear.app/matrix-os/issue/ENG-22) regression, and [ENG-296](https://linear.app/matrix-os/issue/ENG-296) model compatibility. Implementation sequence and release limits: [plan](./plan.md).

## Goal and behavior

An eligible customer who adds credit must be able to spend that actual credit when their runtime uses a credit-backed budget. A fixed operator ceiling remains authoritative. New automatically initialized starter policies use credit-backed budgeting; existing policies migrate to fixed and require a reviewed, revisioned operator update before adopting it.

The theoretical monthly ceiling is settled spend in the current UTC month plus nonnegative real credit net of funding shortfall. Reservations still reduce available funds and budget. Grants, promotion handoffs, refunds, dispute restorations and explicit mode adoption update the ceiling atomically. Duplicates never mint credit or increase the ceiling again. Failed or unknown usage retains its existing settlement protections.

The existing Buy Credit dialog derives availability from a complete authoritative server snapshot. A disabled service flag, incomplete Stripe package configuration, restricted funding, unavailable policy or unhealthy route must not be bypassed by the client. An exhausted credit-backed budget may recover by purchasing credit; an exhausted fixed ceiling cannot.

Subscription allowances use the requester-approved Starter $5 / Builder $10 / Max $20 per subscription month. The original signed subscription anchor determines anniversary boundaries, including short months and leap years. Annual subscribers receive monthly installments. Unused gift credit expires at the installment boundary or paid coverage end; purchased add-ons remain permanent. Upgrades receive only the paid current-month difference; downgrades apply next month, determined by signed event time. Cancellation retains eligibility through paid coverage. Historical lifetime $5 offsets the first installment; only its unspent remainder receives that installment's expiry, preserving the original immutable ledger entry.

Signed subscription projections and paid invoices record bounded authoritative terms/coverage. Active status alone is insufficient. Delivery and owner/slot/cycle entitlement keys prevent duplicate grants and spent-balance refills. Billing events and ordinary funded reads/non-probe credential issuance lazily issue only the current eligible installment; checkout stays read-only. No scheduler, expired-month backfill or external Stripe request is added. New behavior remains behind the default-off `MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED` flag.

Before production activation, historical subscriptions need separately reviewed, authoritative enrollment of anchor and paid invoice metadata. Already processed events return through webhook deduplication and cannot bootstrap these records. Do not delete receipts or guess paid dates. Missing/ambiguous authority, overlapping cycles, extensions of a recorded cycle expiry and moved legacy credit fail closed for reconciliation.

## Affected surfaces and security

Web Canvas, Web Desktop and Electron Desktop share the existing purchase dialog; no UI layout or copy changes. Component regression tests cover disabled and recovered states. Web Mobile and Native Mobile retain their existing purchase capability. Live surface verification remains a separate gate because this task may not operate Runtime/Browser instances or GUI.

Existing owner-authenticated purchase routes, signed Stripe webhooks and authenticated operator policy routes retain their auth, validation and body limits. Only operator policy input/output accepts an optional budget mode; the legacy funding receipt shape stays unchanged. No new public route, network call, buffer or credential is added. Invalid configuration and accounting overflow fail closed and roll back the transaction.

## Concurrency and acceptance

Financial writes use PostgreSQL/Kysely transactions. Account-deletion/billing locks precede the funded-owner lock when both are needed; machine/policy/balance locks follow. Credential issuance and pre-upstream release share funded-owner serialization. Refund/dispute reconciliation resolves the owner without locking, then locks and rereads the claim; pending deletion does not discard monetary reconciliation. Policy changes use expected revisions and write-statement compare-and-swap.

Acceptance: duplicate purchase deliveries credit once; unpaid/invalid sessions never credit; refunds and won/lost disputes remain monotonic; real purchased funds exceed the original starter cap only in credit-backed mode; fixed caps remain enforced; promotion transfers align both budgets; anniversary expiry does not stack expired funds; delayed downgrades cannot extend a higher tier; annual billing catches up only the current installment; unpaid, trialing, wrong-owner and ambiguous subscriptions issue nothing. Native PostgreSQL tests observe actual contention before row locks. Eight-model registry, bounds and compatibility regressions reuse PR #2628.

## Release and rollback

Code delivery does not enable production purchases, grant subscription allowances or activate eight models. Existing merged Relay changes belong to the other task's clean-main release. Production price reviews, global/runtime allowlists, probe counters, Host compatibility and real Chat/Bot settlement need their own approval/evidence.

Rollback disables future issuance, preserves all ledger/reservation records and keeps code capable of settling every admitted version. Historical fixed caps are unchanged. Do not roll back budget-mode-aware code after activating credit-backed runtimes without restoring a reviewed fixed ceiling. Public product documentation requires a separate site-repository PR describing approved rules with activation still pending. Full Linux CI remains blocked by the required Draft state; local verification does not qualify a release.

Scope clarification pending: requester is deciding whether allowances are per independently paid computer subscription or only the account primary subscription. The current draft preserves the existing primary-only restriction and stays disabled; do not activate before this is resolved.

Late-event correction: a funding read can issue the old tier before a delayed downgrade arrives. Reconcile the cycle from immutable gross grants minus its expiry audits (net issuance includes settled usage, never a balance refill). Expire stale backing using existing per-grant active-allocation protection, then issue only the positive legitimate difference under a distinct gross-issuance key. Held backing remains expired after release/settlement; purchased funds and settled charges are unchanged. A later legitimate upgrade can restore its remaining entitlement without duplicate grant-key conflicts. Targeted new-module coverage passes the repository thresholds:99.09% statements,97.98% branches,100% functions/lines across73targetedtests (649passed in33file combined native run).
