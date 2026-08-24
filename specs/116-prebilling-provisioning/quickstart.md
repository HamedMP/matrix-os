# Validation Quickstart: Prebilling Provisioning

This feature is developed test-first and remains disabled by default until every access and cleanup invariant passes. Commands run from the repository root of the feature worktree.

## 1. Red: Contract and State-Machine Tests

Add failing tests before each implementation slice. Start with focused suites for:

- strict checkout schema, canonical selections, conflicting retries, and no-provider-call checkout failure
- intent, capacity-reservation, activation, and cleanup migrations/queries
- revision-checked transition helpers and event replay idempotency
- provisioning-worker authorization-basis rechecks
- signed subscription promotion and server-owned fallback provisioning
- Stripe-expiry and billing-versus-cleanup races
- journey response and onboarding component states

Run the smallest affected Vitest target first, for example:

```bash
pnpm exec vitest run tests/platform/billing-routes.test.ts
pnpm exec vitest run tests/platform/customer-vps-provisioning-durability.test.ts
pnpm exec vitest run tests/shell/prebilling-onboarding.test.tsx
```

Use actual discovered filenames when implementation starts; do not create parallel test conventions solely to match these examples.

## 2. Green: Fake Stripe and Provider Integration

The hermetic full-path integration test must exercise:

```text
authenticated checkout request
  -> durable checkout/intent claim
  -> fake Stripe open session
  -> durable provider job
  -> fake provider create/reconcile
  -> physical machine ready but inaccessible
  -> signed subscription event
  -> atomic activation
  -> runtime HTTP and WebSocket access
```

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

## 3. Repository Verification

Run focused tests during red/green/refactor, then the repository gates appropriate to the touched packages:

```bash
bun run test
bun run test:coverage
bun run build:shell:production
pnpm dlx react-doctor@latest .
```

Also run the repository's platform typecheck/lint targets discovered at implementation time. New platform/gateway logic targets 99–100% branch coverage, especially authorization and cleanup predicates.

## 4. Preproduction Validation

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

## 5. Production Rollout

Roll out only new-primary onboarding through deterministic cohorts:

1. `0%`: migrations/workers deployed; admission off; synthetic/fake soak.
2. Internal allowlist: explicit cost ceiling and on-call coverage.
3. `1%`: hold through at least one full cleanup window and inspect every intent.
4. `10%`: hold until latency, conversion, cleanup, duplicate, and entitlement-gap thresholds pass.
5. `50%`: repeat the hold and compare against the postbilling control cohort.
6. `100%`: retain flag, caps, dashboards, and continuation workers permanently.

At any stop, set new admission to zero. Do not disable authorization reconciliation, fallback provisioning, or cleanup.

## 6. Delivery and Documentation

- Ship the implementation as one monitored PR with phase commits for flag-off persistence/workers, checkout/authorization, and shell/journey/observability, per the requester's explicit delivery direction.
- Every PR uses a Conventional Commit title, includes the mandatory invariant section, and reaches trusted current-head Greptile `5/5` before merge.
- Open a separate public-safe PR in `FinnaAI/matrix-os-site` under `content/docs/` explaining compute → agents → secure checkout/preparation → billing authorization → ready. Do not publish provider details, private hostnames, internal IDs, credentials, or operator commands.
- This onboarding/platform change deploys through the platform/app-shell path. It is not a customer VPS Docker or host-bundle rollout unless a later implementation diff independently changes host-bundle contents.
