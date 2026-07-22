# Staging Platform and Feature VPS Runbook

Use this runbook when a feature needs to be walked **end to end against branch
platform code** before it merges — especially the onboarding and billing flow
(sign in -> plan -> Stripe test checkout -> settling -> provision -> boot ->
ready). It is the manual/deep-debug path. For the standard, automated preview
flows, start with [Preview Environments](preview-environments.md):

| You want | Use | Where |
| --- | --- | --- |
| Shell/gateway UI iteration | Staging slot (HMR) | `preview-environments.md` |
| Bundle on a virgin VPS | `preview-vps` label | `preview-environments.md` |
| Branch platform API in isolation | `preview-platform` label (Cloud Run) | `preview-environments.md` |
| **Full onboarding + billing on branch code** | **this runbook** | below |

## Architecture (read this first)

Production Matrix OS is VPS-native per user with the **platform on Cloud Run**.
There is no local platform Docker container on the ops VPS, and there is no
single turnkey environment that runs branch platform code with **Stripe test
mode** against a **non-production database**, browser-reachable. So the full
onboarding flow is tested as a **pragmatic split** across the tools that each
cover one slice:

| Slice (PR area) | Tool | Why |
| --- | --- | --- |
| Boot sequence, auth door / origins (shell) | Staging slot (HMR) | Fast, browser-reachable, runs the branch shell. |
| Journey endpoint + provisioning reliability (platform) | `preview-platform` Cloud Run revision | Branch platform code on the staging DB; reached via an IAM proxy. |
| Stripe checkout + webhook (billing) | Local platform from the worktree + Stripe CLI | The only place test-mode keys + a forwarded webhook are wired. |
| Provisioned shell on a real host | Disposable feature VPS | Confirms the boot -> first-run -> ready hand-off on a real customer VPS. |

> Known gap: combining all four into one browser-reachable environment is not
> wired yet (`preview-platform` is IAM-only and has no Stripe secrets;
> `preview-vps` provisions against the **production** platform; the GitHub
> `staging` environment is a no-traffic revision of the production service).
> Closing it durably means either adding Stripe test secrets to
> `matrix-platform-preview` and fronting it with auth, or standing up a
> dedicated isolated staging platform. Until then, use the split below.

## Slice 1 — Shell (boot sequence, auth door, origins)

Claim a staging slot for the feature worktree. Edits hot-reload; no rebuild.

```bash
./scripts/staging-slot.sh up /home/deploy/matrix-os.worktrees/<feature-worktree>
# -> shell: https://staging-<n>.matrix-os.com  api: https://api-staging-<n>.matrix-os.com
./scripts/staging-slot.sh down <n>   # release when done — slots are shared
```

Walk the sign-in door, redirect/return behavior, and the boot-sequence phases
the shell renders. See [Preview Environments](preview-environments.md) for slot
details and log access (`preview-logs.sh --slot <n>`).

## Slice 2 — Platform journey + provisioning reliability

Deploy the branch as a `preview-platform` revision (add the `preview-platform`
label to the PR, or `gh workflow run preview-platform.yml -f pr=<N>`), then
reach it through an IAM proxy from a host with `gcloud` access:

```bash
gcloud run services proxy matrix-platform-preview --region europe-west3 --port 8080
# then, in another shell, with a bearer for your Clerk user:
curl -fsS -H "Authorization: Bearer <token>" http://127.0.0.1:8080/api/journey | jq .
```

The revision runs on the **staging** database, so you can drive the journey
state machine and the reliability fixes directly:

- **Phase derivation**: seed the staging DB so the user has an active
  entitlement but no machine, then assert `/api/journey` reports
  `provisioning`/`first_run`/`ready` as the machine progresses.
- **Stuck-row reconciliation / TTL**: insert a `user_machines` row stuck mid
  provision (or let a registration token expire) and confirm the reconciler
  marks it failed, reaps the server, and unblocks re-provisioning.
- **Lapsed entitlement**: expire the entitlement and confirm the journey routes
  back to `plan_required` rather than serving a dead machine.

Connect to the staging DB through the dedicated staging postgres container on
the ops VPS (database `matrixos_staging`). Never seed or mutate the production
platform database for testing.

## Slice 3 — Stripe checkout + webhook (test mode)

Run the platform locally from the feature worktree with test-mode billing, and
forward Stripe webhooks to it with the Stripe CLI. Keep all secrets in
`.env.staging-platform` (test-mode keys only — never production Stripe keys):

```bash
cd /home/deploy/matrix-os.worktrees/<feature-worktree>
set -a; source /home/deploy/matrix-os/.env.staging-platform; set +a

# 1) forward webhooks; copy the printed whsec_... into STRIPE_WEBHOOK_SECRET
stripe listen --forward-to "localhost:${PLATFORM_PORT:-9000}/billing/webhooks/stripe"

# 2) in another shell (same env), run only the platform
bun run dev:platform
```

Drive a checkout for a test plan, pay with `4242 4242 4242 4242`, and confirm:

- the checkout attempt is recorded `open`, then flips to `paid` on
  `checkout.session.completed`;
- a success redirect that **beats** the webhook lands the journey in
  `payment_settling` (not back at the billing wall) and advances once the
  webhook arrives — the checkout-success-vs-webhook race;
- `checkout.session.expired` resolves the attempt to `expired`.

## Slice 4 — Disposable feature VPS

Provision a non-primary feature VPS bound to **your** Clerk user so you can open
it in a browser with your normal login. Provision through the platform operator
API (use the platform instance that owns the test — production operator API for
a bundle-only check, or your local/preview platform when the VPS must talk to
branch platform code). Never use the `primary` runtime slot for branch testing.

```bash
set -a; source /home/deploy/matrix-os/.env.staging-platform; set +a
PLATFORM_API_URL="<platform-operator-base-url>"

curl --fail --silent --show-error \
  -X POST "${PLATFORM_API_URL%/}/containers/provision" \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "handle": "<feature-handle>",
    "clerkUserId": "<your-clerk-user-id>",
    "displayName": "<feature-handle>",
    "runtimeSlot": "<feature-handle>"
  }'
```

Build and pin an immutable host bundle from the feature worktree, then deploy
that exact version to only the feature handle:

```bash
set -a; source /home/deploy/matrix-os/.env; set +a
VERSION="v$(date -u +%Y.%m.%d)-pr<PR>-<short-feature>-$(git rev-parse --short=9 HEAD)"

HOST_BUNDLE_VERSION="$VERSION" HOST_BUNDLE_CHANNEL=dev \
MATRIX_BUILD_SHA="$(git rev-parse HEAD)" MATRIX_BUILD_REF="$(git rev-parse --abbrev-ref HEAD)" \
  ./scripts/build-host-bundle.sh
./scripts/publish-release.sh "$VERSION" --channel dev --changelog "Feature preview $(git rev-parse --abbrev-ref HEAD)"

curl --fail --silent --show-error \
  -X POST "${PLATFORM_API_URL%/}/vps/deploy" \
  -H "Authorization: Bearer $PLATFORM_SECRET" -H "Content-Type: application/json" \
  -d "{\"version\":\"$VERSION\",\"handle\":\"<feature-handle>\"}"
```

Open the runtime at `https://app.matrix-os.com/vm/<feature-handle>` and verify
the host directly (gateway is usually `4000`, shell `3000`):

```bash
ssh -i ~/.ssh/customer_vps_smoke -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
  root@<publicIPv4> \
  'cat /opt/matrix/app/BUNDLE_VERSION; systemctl is-active matrix-gateway matrix-shell matrix-sync-agent; curl -fsS http://127.0.0.1:4000/health; curl -fsS -o /dev/null -w "shell_status=%{http_code}\n" http://127.0.0.1:3000'
```

## Tear Down

Always delete feature VPSes through the platform so Hetzner deletion and
platform soft-delete metadata stay consistent — never delete directly in
Hetzner.

```bash
# find the machine, then delete by id
curl -fsS -H "Authorization: Bearer $PLATFORM_SECRET" "${PLATFORM_API_URL%/}/vps/fleet" \
  | jq '.machines[] | select(.handle == "<feature-handle>") | {handle, machineId, status, publicIPv4}'
curl -fsS -X DELETE "${PLATFORM_API_URL%/}/vps/<machineId>" -H "Authorization: Bearer $PLATFORM_SECRET"
```

Stop the local billing rig (`Ctrl-C` the `dev:platform` and `stripe listen`
processes), release any staging slot (`staging-slot.sh down <n>`), and remove
any temporary Cloudflare route you added, restarting cloudflared and confirming
production routes are intact.

## Rules

- Keep `/home/deploy/matrix-os` on `main`; do feature work in a manual worktree
  under `/home/deploy/matrix-os.worktrees/<slug>`.
- Never seed or mutate the **production** platform database for testing; use the
  staging database.
- Never copy production Stripe keys into `.env.staging-platform`. Test-mode keys
  only.
- Never use the `primary` runtime slot, and never deploy a feature bundle to the
  whole fleet.
- Delete feature VPSes through `DELETE /vps/<machineId>`; remove temporary
  Cloudflare routes after testing.

## Production Stripe Checklist

Before promoting Stripe billing to production, configure the production Stripe
account and production platform env:

1. Create production Products and recurring Prices (Starter, Builder, Max —
   monthly and annual; extra-runtime add-on if launching multiple machines).
2. Copy the production Price IDs into the production platform env
   (`STRIPE_PRICE_MATRIX_*`). Each billable computer uses its own full plan subscription.
3. Enable automatic tax for Checkout and Portal; add required tax registrations.
4. Enable promotion codes in Checkout and Customer Portal (Stripe Coupons /
   Promotion Codes, not hardcoded discounts).
5. Configure the production webhook endpoint
   (`https://app.matrix-os.com/billing/webhooks/stripe`) and subscribe to
   `customer.subscription.created|updated|deleted`.
6. Store the production webhook signing secret as `STRIPE_WEBHOOK_SECRET`.
7. Use a **restricted** production key for `STRIPE_SECRET_KEY` (Customers,
   Checkout Sessions, Billing Portal Sessions, Subscriptions, Prices, webhook
   signature handling only).
8. Set production return URLs (`STRIPE_CHECKOUT_SUCCESS_URL`,
   `STRIPE_CHECKOUT_CANCEL_URL`, `STRIPE_PORTAL_RETURN_URL`).
9. Set `MATRIX_BILLING_PROVIDER=stripe` or `MATRIX_STRIPE_BILLING_ENABLED=true`
   on the production platform.
10. Rebuild the host bundle after changing any `NEXT_PUBLIC_*` value; build a
    stable release from the merge commit for traceability.

After production env is set, merge the stack, build a host bundle from `main`,
publish it, promote it to `stable`, deploy the fleet by `stable`, and verify
every running VPS reports the stable version.
