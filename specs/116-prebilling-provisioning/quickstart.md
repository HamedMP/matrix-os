# Validation Quickstart: Prebilling Provisioning

This feature is developed test-first and remains disabled by default until every access and cleanup invariant passes. Commands run from the repository root of the feature worktree.

Admission requires all of these server-owned settings; missing values keep it off:

```text
MATRIX_PREBILLING_PROVISIONING_ENABLED=true
MATRIX_PREBILLING_PROVISIONING_ROLLOUT_PERCENT=<0..100>
MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE=<positive integer>
MATRIX_PREBILLING_PROVISIONING_MAX_HOURLY_COST_MICROS=<positive integer>
MATRIX_PREBILLING_PROVISIONING_COSTS_JSON={"cpx22":...,"cpx32":...,"cpx52":...}
```

Setting `ENABLED=false` or rollout to `0` stops only new admission. Signed subscription activation and signed-expiry cleanup remain wired so existing intents can converge safely.

## 1. Fake Stripe and Provider Integration

Required negative/race cases:

- concurrent identical checkout requests produce one session, intent, job, and provider machine
- conflicting selections cannot mutate a payable intent
- Checkout creation definite failure produces zero provider calls
- capacity/cost denial produces zero provider calls and safely falls back after authorization
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

## 3. Delivery and Documentation

- Ship the implementation as one monitored PR with phase commits for flag-off persistence/workers, checkout/authorization, and shell/journey/observability, per the requester's explicit delivery direction.
- Every PR uses a Conventional Commit title, includes the mandatory invariant section, and reaches trusted current-head Greptile `5/5` before merge.
- Open a separate public-safe PR in `FinnaAI/matrix-os-site` under `content/docs/` explaining compute → agents → secure checkout/preparation → billing authorization → ready. Do not publish provider details, private hostnames, internal IDs, credentials, or operator commands.
- This onboarding/platform change deploys through the platform/app-shell path. It is not a customer VPS Docker or host-bundle rollout unless a later implementation diff independently changes host-bundle contents.
