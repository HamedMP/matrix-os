# Quickstart: Unified Onboarding State Machine (092)

How to develop against and verify this feature locally.

## Run the stack

```bash
flox activate
bun run dev          # gateway + proxy + shell
bun run dev:platform # platform on :9000 (needs platform Postgres + .env)
```

## Inspect a user's journey

```bash
# As the signed-in browser user (cookie auth):
curl -s --cookie "$CLERK_COOKIES" http://localhost:9000/api/journey | jq

# As a CLI/native client (sync JWT):
curl -s -H "Authorization: Bearer $SYNC_JWT" http://localhost:9000/api/journey | jq
```

## Force each phase for testing

| Phase | How |
|-------|-----|
| `plan_required` | New Clerk user, no `billing_entitlements` row |
| `payment_settling` | Insert an `open` row in `billing_checkout_attempts` (< settling window), no active entitlement |
| `provisioning` | Active entitlement + `user_machines` row in `provisioning` (the journey derives the stage from `hetzner_server_id`/`public_ipv4`) |
| `provisioning_failed` | Set machine `status='failed'`, `failure_code='registration_timeout'` |
| `first_run` | Machine `running`, delete the user's `onboarding_first_run` row |
| `ready` | Machine `running` + `onboarding_first_run` row present |

## Verify the reliability fixes

```bash
# Stuck provisioning → failed (R2 gap 1): create a provisioning row with
# registration_token_expires_at in the past, wait one reconciler interval (60s), then:
docker compose -f distro/docker-compose.platform.yml --env-file .env exec postgres \
  psql -U postgres -d platform -c \
  "SELECT machine_id, status, failure_code FROM user_machines ORDER BY provisioned_at DESC LIMIT 3;"

# Failed row no longer blocks (R2 gap 2): with a failed row present,
curl -s -X POST -H "Authorization: Bearer $SYNC_JWT" \
  http://localhost:9000/api/journey/retry-provision | jq   # → {"status":"started"}

# Settling (R3): complete a Stripe test checkout with the webhook listener paused;
# journey must report payment_settling (not plan_required) until the webhook fires.
stripe listen --forward-to localhost:9000/billing/webhooks/stripe
```

## Test suites

```bash
bun run test                     # unit; includes tests/platform/journey.test.ts,
                                 # customer-vps-reconcile.test.ts, billing-settling.test.ts,
                                 # tests/shell/boot-sequence.test.tsx
bun run typecheck
bun run check:patterns
bun run test:e2e                 # onboarding-activation.spec.ts walks sign-in → ready
npx react-doctor@latest shell    # required: BootSequence/OnboardingScreen are React changes
```

## CLI flow

```bash
cd packages/sync-client && pnpm build
mos login                        # entitled user w/o machine: offers `mos setup`
mos setup                        # triggers provisioning, streams stage progress
```
