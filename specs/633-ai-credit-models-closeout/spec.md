# Funded credit closeout

Tracks [ENG-182](https://linear.app/matrix-os/issue/ENG-182), [ENG-22](https://linear.app/matrix-os/issue/ENG-22) regression, and [ENG-296](https://linear.app/matrix-os/issue/ENG-296) model compatibility. Implementation sequence and release limits: [plan](./plan.md).

## Goal and behavior

An eligible customer who adds credit must be able to spend that actual credit when their runtime uses a credit-backed budget. A fixed operator ceiling remains authoritative. New automatically initialized starter policies use credit-backed budgeting; existing policies migrate to fixed and require a reviewed, revisioned operator update before adopting it.

The theoretical monthly ceiling is settled spend in the current UTC month plus nonnegative real credit net of funding shortfall. Reservations still reduce available funds and budget. Grants, promotion handoffs, refunds, dispute restorations and explicit mode adoption update the ceiling atomically. Duplicates never mint credit or increase the ceiling again. Failed or unknown usage retains its existing settlement protections.

The existing Buy Credit dialog derives availability from a complete authoritative server snapshot. A disabled service flag, incomplete Stripe package configuration, restricted funding, unavailable policy or unhealthy route must not be bypassed by the client. An exhausted credit-backed budget may recover by purchasing credit; an exhausted fixed ceiling cannot.

Subscription allowances have an internal, default-off configuration/issuer foundation only. Every configured plan must explicitly state amount, cadence and expiry. Billing determines the active plan. Owner/cycle ledger keys deduplicate delivery. Unapproved plan or cadence transitions fail closed. No automatic caller, scheduler, production rule or new endpoint is installed. Product owners should review tier mapping, timing, starter overlap and transition rules before the separate activation change.

## Affected surfaces and security

Web Canvas, Web Desktop and Electron Desktop share the existing purchase dialog; no UI layout or copy changes. Component regression tests cover disabled and recovered states. Web Mobile and Native Mobile retain their existing purchase capability. Live surface verification remains a separate gate because this task may not operate Runtime/Browser instances or GUI.

Existing owner-authenticated purchase routes, signed Stripe webhooks and authenticated operator policy routes retain their auth, validation and body limits. Only operator policy input/output accepts an optional budget mode; the legacy funding receipt shape stays unchanged. No new public route, network call, buffer or credential is added. Invalid configuration and accounting overflow fail closed and roll back the transaction.

## Concurrency and acceptance

Financial writes use PostgreSQL/Kysely transactions. Account-deletion/billing locks precede the funded-owner lock when both are needed; machine/policy/balance locks follow. Credential issuance and pre-upstream release share funded-owner serialization. Refund/dispute reconciliation resolves the owner without locking, then locks and rereads the claim; pending deletion does not discard monetary reconciliation. Policy changes use expected revisions and write-statement compare-and-swap.

Acceptance: duplicate purchase deliveries credit once; unpaid/invalid sessions never credit; refunds and won/lost disputes remain monotonic; real purchased funds exceed the original starter cap only in credit-backed mode; fixed caps remain enforced; promotion transfers align both budgets; configurable monthly expiry does not stack expired funds; unapproved subscription transitions issue nothing. Native PostgreSQL tests observe actual contention before row locks. Eight-model registry, bounds and compatibility regressions reuse PR #2628.

## Release and rollback

Code delivery does not enable production purchases, grant subscription allowances or activate eight models. Existing merged Relay changes belong to the other task's clean-main release. Production price reviews, global/runtime allowlists, probe counters, Host compatibility and real Chat/Bot settlement need their own approval/evidence.

Rollback disables future issuance, preserves all ledger/reservation records and keeps code capable of settling every admitted version. Historical fixed caps are unchanged. Do not roll back budget-mode-aware code after activating credit-backed runtimes without restoring a reviewed fixed ceiling. Public product documentation requires a separate site-repository PR once rules are confirmed.
