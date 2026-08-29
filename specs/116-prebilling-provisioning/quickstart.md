# Validation Quickstart: Prebilling Provisioning

This feature is developed test-first and remains disabled by default until every access and cleanup invariant passes. Commands run from the repository root of the feature worktree.

Admission requires all of these server-owned settings; missing values keep it off:

```text
MATRIX_PREBILLING_PROVISIONING_ENABLED=true
MATRIX_PREBILLING_PROVISIONING_ROLLOUT_PERCENT=<0..100>
MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE=<positive integer>
```

Setting `ENABLED=false` or rollout to `0` stops new unpaid provider work: awaiting intents are not admitted, failed unpaid preparations are not reset for retry, and a `preparing` crash state cannot create its first machine on resume. Detached work already in flight may settle, while paid-intent bypass, signed subscription activation, and signed-expiry cleanup remain wired so existing intents can converge safely.

## Rollback to a Cost-Aware Revision

The retained database column avoids a schema rollback, but count-only revisions intentionally write it as zero. A direct traffic rollback remains inside the accepted count-only exposure because the former binary also enforces `MAX_ACTIVE`; its monetary ceiling becomes exact only after those zero-valued active rows reach a terminal state.

When an immediate monetary ceiling is required, use this order:

1. Manually dispatch `platform-cloud-run.yml` from the count-only revision with `environment=production`, `promote=true`, and `prebilling_rollback_drain=true`. The workflow rejects drain requests that are not promoted production deployments, verifies admission is disabled, leaves continuation workers enabled, and sends 100% of traffic to the drain revision.
2. Wait one full 31-minute checkout lease, or query under the prebilling advisory lock and verify there are no unpaid intents in active preparation states with a zero legacy reservation.
3. Shift traffic to the former cost-aware revision and restore its legacy cost settings.

Never restore legacy cost settings before step 2. Paid-intent continuation bypasses unpaid admission and remains available throughout the drain.

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
