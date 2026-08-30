# Validation Quickstart: Prebilling Provisioning

This feature is developed test-first. The production deployment contract keeps count-only prebilling enabled at 100% rollout with a global maximum of four active unpaid preparations. Commands run from the repository root of the feature worktree.

Admission requires all of these server-owned settings:

```text
MATRIX_PREBILLING_PROVISIONING_ENABLED=true
MATRIX_PREBILLING_PROVISIONING_ROLLOUT_PERCENT=<0..100>
MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE=<positive integer>
```

Setting `ENABLED=false` or rollout to `0` stops new unpaid provider work: awaiting intents are not admitted, failed unpaid preparations are not reset for retry, and a `preparing` crash state cannot create its first machine on resume. Detached work already in flight may settle, while paid-intent bypass, signed subscription activation, and signed-expiry cleanup remain wired so existing intents can converge safely.

## Operational Policy and Future Rollback

Count-only prebilling remains enabled in the production deployment workflow. There is no prebuilt workflow-dispatch path that disables admission for a rollback drain. If exceptional rollback behavior is ever required, it must be introduced through a separate reviewed workflow/code PR with an explicit transition plan.

The retained database cost column avoids a schema migration and remains written as zero by count-only revisions. It is excluded from the provisioning domain and admission decisions, while preserving schema compatibility for a future reviewed PR that deliberately restores cost-based behavior.

## 1. Fake Stripe and Provider Integration

Required negative/race cases:

- concurrent identical checkout requests produce one session, intent, job, and provider machine
- conflicting selections cannot mutate a payable intent
- Checkout creation definite failure produces zero provider calls
- count-capacity denial produces zero provider calls and safely falls back after authorization
- provider create timeout reconciles the accepted machine instead of creating another
- physical readiness before billing remains inaccessible across session routing, explicit VM routing, app session, runtime API, code-domain routing, WebSocket, terminal, recover, resize, and resume paths
- checkout completion without a subscription projection remains `payment_settling` and is not deleted
- Stripe expiry without entitlement cleans up; deletion timeout reconciles until provider absence
- signed authorization racing every cleanup phase cancels cleanup before irreversible deletion and preserves one machine
- stale expiry after authorization cannot reverse activation
- preparation failure followed by authorization creates exactly one entitlement-backed fallback job
- existing paid, additional-computer, recovery, resize, grace, suspension, and preview tests are unchanged

## 2. Preproduction Validation

No live resource is created from this planning artifact. After implementation has an exact reviewed head and explicit operator approval:

1. Deploy schema and continuation workers with admission disabled.
2. Verify migrations, worker registration, cleanup drains, and metrics in the worker-enabled platform revision before directing traffic to it.
3. Run Stripe test-mode checkout plus a disposable feature VPS in the selected region/shape.
4. Delay checkout long enough to prove overlap; verify all prebilling routing probes deny access.
5. Deliver the signed test subscription projection and verify activation uses the same machine.
6. Repeat with authoritative expiry and verify provider absence plus local-secret cleanup.
7. Repeat the authorization-vs-cleanup race under instrumentation.
8. Validate Canvas onboarding first, then Desktop and refresh/multi-tab resumption.
9. Ask whether to delete any disposable test VPS after validation to avoid charges; cleanup of test resources must be confirmed.

The implementation PR performs no live Stripe, provider, deployment, or billing mutation. Test-mode/disposable-VPS validation remains an operator-approved post-review step.
