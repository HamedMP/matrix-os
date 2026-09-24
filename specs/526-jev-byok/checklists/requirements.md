# Checklist: Jev email triage

Updated: 2026-09-22. [Spec](../spec.md), [design](../design.zh-en.md), [plan](../plan.md).

- [x] The first release is one complete Gmail triage workflow, not a generic Jev product.
- [x] Matrix Gateway funding is explicit and personal Jev keys are excluded.
- [x] The primary model's provider/account remains independent from Jev funding.
- [x] Gateway, immutable recipe and agent skill responsibilities are separated.
- [x] Exact route authentication and public/private status are documented.
- [x] Request, response, timeout, redirect, concurrency and rate boundaries are documented.
- [x] The seven independent Boolean outputs and validation rules are explicit.
- [x] Snippet/full-context triggers, label thresholds, Review behavior and archive gate are deterministic.
- [x] Jev output is never authorization; Gmail mutations use existing authorized actions.
- [x] Sending, replying, forwarding, trashing and deleting are prohibited.
- [x] Owner isolation, credit denial, idempotency, unknown outcomes and safe errors are covered.
- [x] Raw email content and credentials are excluded from normal logs/accounting.
- [x] Runtime wiring and full-path integration testing are specified.
- [x] Agent support requires discovery, tool registration and real invocation evidence.
- [x] TDD, manual worktree, stacked PR, Greptile/CI and separate public docs deliverables are included.
- [x] Jev Ultrafast, generic workflows and additional recipes are explicitly deferred.

Document review only; no runtime result or production availability is claimed.
