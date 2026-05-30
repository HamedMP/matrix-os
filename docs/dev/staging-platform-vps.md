# Staging Platform and Feature VPS Runbook

Use this runbook when a feature needs a real platform process, Stripe test mode,
or a disposable customer VPS before it merges. The goal is to test production
runtime behavior without breaking stable bundles, production platform state, or a
user's primary Matrix computer.

For branch-only customer runtime testing, also see
[PR and Branch Preview VPS Guide](pr-branch-preview-vps.md). For production
release fan-out, see [Release Process](releases.md) and
[Fleet Upgrade Operations](fleet-upgrade-operations.md).

## Architecture

Staging uses three separate pieces:

| Piece | Purpose | Lifetime |
| --- | --- | --- |
| Feature worktree | Source code for the branch or stacked PR under test. | Until the PR lands. |
| Staging platform container | A non-production platform process on the platform Docker network, usually bound to `127.0.0.1:9100`. | While the feature is being tested. |
| Feature VPS | A real Hetzner customer VPS in a non-primary runtime slot, such as `hamed-billing-staging`. | Delete after validation. |

The staging platform is allowed to use Stripe test-mode keys and staging return
URLs. It must not be used as the stable-channel publisher for production users.

## Environment Files

Keep staging secrets outside git. The current convention on the platform host is:

```text
/home/deploy/matrix-os/.env.staging-platform
```

Required staging variables:

| Variable | Notes |
| --- | --- |
| `PLATFORM_SECRET` | Local operator API bearer token for staging routes. |
| `CLERK_SECRET_KEY` | Clerk instance used by the staging platform. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Build-time shell key for branch bundles. |
| `CUSTOMER_VPS_ENABLED=true` | Required for real feature VPS provisioning. |
| `HETZNER_API_TOKEN` | Hetzner project token that may create/delete feature VPSes. |
| `HETZNER_LOCATION` / `HETZNER_SERVER_TYPE` / `HETZNER_IMAGE` / `HETZNER_SSH_KEY_NAME` | Provider defaults for feature VPSes. |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | Bundle publish and signed download support. |
| `PLATFORM_PUBLIC_URL` | Staging platform public URL, for example `https://staging-app.matrix-os.com`. |
| `MATRIX_APP_DOMAIN_HOSTS` | Include staging app hosts; include production app hosts only for a deliberate temporary route. |
| `MATRIX_BILLING_PROVIDER=stripe` or `MATRIX_STRIPE_BILLING_ENABLED=true` | Enables Stripe-backed billing paths. |
| `STRIPE_SECRET_KEY` | Stripe test-mode secret key for staging. |
| `STRIPE_WEBHOOK_SECRET` | Stripe CLI or Dashboard webhook signing secret for staging. |
| `STRIPE_PRICE_MATRIX_*` | Test-mode Stripe Price IDs for Starter, Builder, and Max monthly/annual prices. |
| `STRIPE_CHECKOUT_SUCCESS_URL` / `STRIPE_CHECKOUT_CANCEL_URL` / `STRIPE_PORTAL_RETURN_URL` | Return URLs for the feature VPS being tested. |
| `STAGING_PLATFORM_PORT` | Local staging platform port, usually `9100`. |

Do not copy production Stripe keys into `.env.staging-platform`. Do not copy
`PLATFORM_JWT_SECRET` or production-only provider secrets onto customer VPSes.

## Start a Staging Platform

1. Build from the feature worktree, not from `main`.

   ```bash
   cd /home/deploy/matrix-os.worktrees/<feature-worktree>
   ```

2. Start or restart the staging platform container with the staging env file.
   The exact compose file may differ by host; the important invariant is that
   the container joins `matrixos-net`, exposes only a local operator port, and
   mounts the feature worktree source.

   ```bash
   docker compose \
     --env-file /home/deploy/matrix-os/.env.staging-platform \
     -f /home/deploy/matrix-os/docker-compose.staging.yml \
     up -d --build
   ```

3. Verify the local operator API.

   ```bash
   set -a
   source /home/deploy/matrix-os/.env.staging-platform
   set +a

   curl --fail --silent --show-error \
     -H "Authorization: Bearer $PLATFORM_SECRET" \
     "http://127.0.0.1:${STAGING_PLATFORM_PORT:-9100}/health"
   ```

4. If Cloudflare needs a temporary route for browser checkout testing, route only
   the minimum path needed. Remove it immediately after testing. For example,
   route `/billing/*` to the staging platform only while validating the branch
   checkout path, then restore production routing.

## Provision a Feature VPS

Use a unique handle and runtime slot. Never use `primary` for branch testing.

```bash
set -a
source /home/deploy/matrix-os/.env.staging-platform
set +a

PLATFORM_API_URL="http://127.0.0.1:${STAGING_PLATFORM_PORT:-9100}"

curl --fail --silent --show-error \
  -X POST "${PLATFORM_API_URL%/}/containers/provision" \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "handle": "alice-feature-staging",
    "clerkUserId": "user_REPLACE_ME",
    "displayName": "alice-feature-staging",
    "runtimeSlot": "alice-feature-staging"
  }'
```

Open the feature runtime at:

```text
https://app.matrix-os.com/vm/<feature-handle>
```

If the staging platform owns the checkout route temporarily, the shell can still
be served by the feature VPS while checkout and portal requests go to staging.

## Build and Pin the Feature Bundle

Build an immutable host bundle from the feature worktree:

```bash
set -a
source /home/deploy/matrix-os/.env
set +a

VERSION="v$(date -u +%Y.%m.%d)-pr<PR>-<short-feature>-$(git rev-parse --short=9 HEAD)"

HOST_BUNDLE_VERSION="$VERSION" \
HOST_BUNDLE_CHANNEL=dev \
MATRIX_BUILD_SHA="$(git rev-parse HEAD)" \
MATRIX_BUILD_REF="$(git rev-parse --abbrev-ref HEAD)" \
./scripts/build-host-bundle.sh

./scripts/publish-release.sh "$VERSION" \
  --channel dev \
  --changelog "Feature preview $(git rev-parse --abbrev-ref HEAD)"
```

Deploy that exact version only to the feature VPS:

```bash
curl --fail --silent --show-error \
  -X POST "${PLATFORM_API_URL%/}/vps/deploy" \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"version\":\"$VERSION\",\"handle\":\"alice-feature-staging\"}"
```

## Verify a Feature VPS

Use the local operator API first:

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  "${PLATFORM_API_URL%/}/vps/fleet" \
  | jq '.machines[] | select(.handle == "alice-feature-staging") | {handle, machineId, status, healthy, publicIPv4, imageVersion, runtimeVersion}'
```

Then verify the host directly. The current smoke key is:

```bash
ssh -i ~/.ssh/customer_vps_smoke \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=accept-new \
  root@<publicIPv4> \
  'cat /opt/matrix/app/BUNDLE_VERSION; cat /opt/matrix/release.json; systemctl is-active matrix-gateway matrix-shell matrix-sync-agent; curl -fsS http://127.0.0.1:4000/health; curl -fsS -o /dev/null -w "shell_status=%{http_code}\n" http://127.0.0.1:3000'
```

Gateway ports are host-bundle conventions, not assumptions from old Docker
runtime docs: gateway is usually `4000`, shell is usually `3000`.

## Tear Down a Feature VPS

Always delete feature VPSes through the platform so Hetzner deletion and platform
soft-delete metadata stay consistent.

1. Find the machine ID.

   ```bash
   curl --fail --silent --show-error \
     -H "Authorization: Bearer $PLATFORM_SECRET" \
     "${PLATFORM_API_URL%/}/vps/fleet" \
     | jq '.machines[] | select(.handle == "alice-feature-staging") | {handle, machineId, status, publicIPv4}'
   ```

2. Delete the feature VPS by machine ID.

   ```bash
   curl --fail --silent --show-error \
     -X DELETE "${PLATFORM_API_URL%/}/vps/<machineId>" \
     -H "Authorization: Bearer $PLATFORM_SECRET"
   ```

3. Confirm it is deleted or absent from the active fleet.

   ```bash
   curl --fail --silent --show-error \
     -H "Authorization: Bearer $PLATFORM_SECRET" \
     "${PLATFORM_API_URL%/}/vps/fleet" \
     | jq '.machines[] | select(.handle == "alice-feature-staging") | {handle, machineId, status, deletedAt}'
   ```

## Stop a Staging Platform

Stop the staging platform container after the feature test is complete:

```bash
docker compose \
  --env-file /home/deploy/matrix-os/.env.staging-platform \
  -f /home/deploy/matrix-os/docker-compose.staging.yml \
  down
```

Remove temporary Cloudflare routes that pointed production hostnames or billing
paths at the staging platform. Restart cloudflared after changing the route
config and verify production routes are back on the production platform.

## Production Stripe Checklist

Before promoting Stripe billing to production, the owner must configure the
production Stripe account and production platform env:

1. Create production Stripe Products and recurring Prices:
   - Starter monthly and annual.
   - Builder monthly and annual.
   - Max monthly and annual.
   - Extra runtime monthly and annual add-on, if the launch includes multiple
     machines.
2. Copy the production Price IDs into the production platform env:
   - `STRIPE_PRICE_MATRIX_STARTER_MONTHLY`
   - `STRIPE_PRICE_MATRIX_STARTER_ANNUAL`
   - `STRIPE_PRICE_MATRIX_BUILDER_MONTHLY`
   - `STRIPE_PRICE_MATRIX_BUILDER_ANNUAL`
   - `STRIPE_PRICE_MATRIX_MAX_MONTHLY`
   - `STRIPE_PRICE_MATRIX_MAX_ANNUAL`
   - `STRIPE_PRICE_EXTRA_RUNTIME_MONTHLY`
   - `STRIPE_PRICE_EXTRA_RUNTIME_ANNUAL`
3. Enable Stripe automatic tax for Checkout and Portal. Add the required tax
   registrations before taking live payments.
4. Enable promotion codes in Checkout and Customer Portal. Create launch coupons
   as Stripe Coupons and Promotion Codes, not Matrix hardcoded discounts.
5. Configure the production webhook endpoint:

   ```text
   https://app.matrix-os.com/billing/webhooks/stripe
   ```

   Subscribe to:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`

6. Store the production webhook signing secret as `STRIPE_WEBHOOK_SECRET`.
7. Use a restricted production Stripe key for `STRIPE_SECRET_KEY` with only the
   permissions needed for Customers, Checkout Sessions, Billing Portal Sessions,
   Subscriptions, Prices, and webhook event signature handling.
8. Set production return URLs:
   - `STRIPE_CHECKOUT_SUCCESS_URL=https://app.matrix-os.com/?billing=success&checkout=success`
   - `STRIPE_CHECKOUT_CANCEL_URL=https://app.matrix-os.com/?billing=canceled`
   - `STRIPE_PORTAL_RETURN_URL=https://app.matrix-os.com/?billing=portal`
9. Set `MATRIX_BILLING_PROVIDER=stripe` or
   `MATRIX_STRIPE_BILLING_ENABLED=true` on production platform.
10. Rebuild the host bundle after changing any `NEXT_PUBLIC_*` value. Platform
    runtime-only Stripe variables do not require a shell rebuild, but a stable
    release should still be built from the merge commit and deployed by version
    for traceability.

After production env is set, merge the stack, build a host bundle from `main`,
publish it, promote it to `stable`, deploy the fleet by `stable`, and verify
every running VPS reports the stable version.

