# PR and Branch Preview VPS Guide

Use this runbook when a pull request or feature branch needs to be tested on a real Matrix OS customer VPS before it merges. This gives engineers a selectable preview runtime under an existing Clerk user without changing the user's primary VPS.

Vercel previews only test the website/platform preview surface. Customer runtime changes need a VPS-native host bundle because the shell, gateway, code service, default apps, and baked public environment variables are shipped through the host-bundle path.

## When to Use This

- A PR changes shell, gateway, onboarding, entitlement gates, billing, integrations, default apps, code service, or VPS runtime behavior.
- The branch needs production-like Clerk, routing, Pipedream, PostHog, R2, or customer VPS systemd behavior.
- The engineer needs to compare a branch runtime against the user's primary runtime from `https://app.matrix-os.com/runtime`.

Do not use this as the normal production rollout path. A preview VPS is a temporary branch runtime and should have its own handle and runtime slot.

## Inputs

| Value | Example | Notes |
|-------|---------|-------|
| Worktree | `/home/deploy/matrix-os.worktrees/add-clerk-billing` | Build from the PR or branch code, not `main`. |
| Branch | `codex/add-clerk-billing` | Recorded in host-bundle metadata as `gitRef`. |
| Version | `v2026.05.28-pr236-clerk-8355b232` | Must match `^[A-Za-z0-9._-]{1,128}$`. Include PR number or branch slug and short SHA. |
| Channel | `beta` | Useful for preview bundles; exact-version deploy is safer than channel fan-out. |
| Existing handle | `hamedmp` | Used to resolve the production Clerk user id. |
| Preview handle | `hamed-clerk` | Must be unique and DNS-safe. |
| Runtime slot | `hamed-clerk` | Must not be `primary`; otherwise provisioning returns the user's existing primary VPS. |

## Version Naming

Use a version that is immutable, traceable, and obviously not a production main release:

```text
vYYYY.MM.DD-pr<PR_NUMBER>-<short-feature>-<SHORT_SHA>
vYYYY.MM.DD-branch-<short-feature>-<SHORT_SHA>
```

Examples:

```text
v2026.05.28-pr236-clerk-8355b232
v2026.05.28-branch-canvas-auth-1a2b3c4d
```

## Build and Publish the Branch Bundle

Run from the PR or branch worktree:

```bash
set -a
source /home/deploy/matrix-os/.env
set +a

VERSION=v2026.05.28-pr236-clerk-8355b232
HOST_BUNDLE_VERSION="$VERSION" \
HOST_BUNDLE_CHANNEL=beta \
MATRIX_BUILD_SHA="$(git rev-parse HEAD)" \
MATRIX_BUILD_REF="$(git rev-parse --abbrev-ref HEAD)" \
./scripts/build-host-bundle.sh

./scripts/publish-release.sh "$VERSION" \
  --channel beta \
  --changelog "Preview branch $(git rev-parse --abbrev-ref HEAD)"
```

The publish step uploads immutable R2 objects under `system-bundles/$VERSION/` and registers the release in platform Postgres. Platform DB release rows and channel pointers are authoritative; R2 only stores the tarball and checksum bytes.

## Resolve the Existing Clerk User

Use the platform operator API and print only the fields needed for the target user. On the platform host, prefer the local API so operator-only routes do not get intercepted by the public auth shell:

```bash
set -a
source /home/deploy/matrix-os/.env
set +a
PLATFORM_API_URL="${PLATFORM_API_URL:-http://127.0.0.1:9000}"

curl --fail --silent --show-error \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  "${PLATFORM_API_URL%/}/vps/fleet" \
  | jq '.machines[] | select(.handle == "hamedmp") | {handle, clerkUserId, runtimeSlot, status, machineId, imageVersion}'
```

If `clerkUserId` is absent from the fleet response, query the platform database directly and only print non-secret machine metadata.

## Provision the Isolated Runtime

Provision through the operator endpoint so Matrix account setup and customer VPS provisioning use the same route as onboarding:

```bash
curl --fail --silent --show-error \
  -X POST "${PLATFORM_API_URL%/}/containers/provision" \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "handle": "hamed-clerk",
    "clerkUserId": "user_REPLACE_ME",
    "displayName": "hamed-clerk",
    "runtimeSlot": "hamed-clerk"
  }'
```

The `runtimeSlot` is the isolation boundary. Reusing `primary` for the same Clerk user returns the existing primary runtime instead of creating a new VPS.

## Pin the Preview VPS to the Branch Version

Provisioning uses the configured customer VPS image channel. If the new VM registers with an older version, or if you want to be explicit, deploy the exact branch bundle only to the preview handle:

```bash
curl --fail --silent --show-error \
  -X POST "${PLATFORM_API_URL%/}/vps/deploy" \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"version":"v2026.05.28-pr236-clerk-8355b232","handle":"hamed-clerk"}'
```

Do not fan out a PR or branch preview bundle to the whole fleet.

## Verify

Poll the fleet until the preview handle is running:

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  "${PLATFORM_API_URL%/}/vps/fleet" \
  | jq '.machines[] | select(.handle == "hamed-clerk") | {handle, clerkUserId, runtimeSlot, status, healthy, publicIPv4, imageVersion}'
```

If `status` is `running` but `healthy` stays `false`, probe the VPS directly with the platform verification token. `/health` returning OK while `/api/system/info` returns 401 usually means the host env is missing `MATRIX_AUTH_TOKEN` or it does not match `UPGRADE_TOKEN`.

Then verify the machine itself:

```bash
ssh root@<publicIPv4> 'cat /opt/matrix/app/BUNDLE_VERSION; cat /opt/matrix/release.json'
ssh root@<publicIPv4> 'systemctl is-active matrix-gateway matrix-shell matrix-code matrix-sync-agent'
ssh root@<publicIPv4> 'curl -fsS http://127.0.0.1:4000/health'
```

Open `https://app.matrix-os.com/runtime` with the target Clerk user and select the preview runtime, or go directly to:

```text
https://app.matrix-os.com/vm/<preview-handle>
```

## Feature-Specific Checks

Add checks for the branch under test. Examples:

| Branch type | Checks |
|-------------|--------|
| Billing | Confirm the target plan is visible, complete checkout with the correct Stripe/Clerk test setup, and verify entitlement state after checkout. |
| Shell or Canvas | Open Canvas first, verify built-ins, window restore, icons, and app launch behavior. |
| Gateway or WebSocket | Verify auth, token paths, health, and expected websocket flows from the preview runtime. |
| Integrations | Verify platform-owned secrets stay on platform and customer VPS calls proxy through the platform route. |
| Default apps | Confirm app manifests, icons, and built `dist` assets load from the preview VPS. |

## Cleanup

Ask the owner before deleting the preview VPS because it creates real Hetzner resources. When it is no longer needed, delete only the preview handle/runtime slot and leave the user's `primary` runtime untouched.

Use the platform delete route so Hetzner cleanup and platform deletion metadata
stay consistent:

```bash
machine_id="$(
  curl --fail --silent --show-error \
    -H "Authorization: Bearer $PLATFORM_SECRET" \
    "${PLATFORM_API_URL%/}/vps/fleet" \
    | jq -r '.machines[] | select(.handle == "hamed-clerk") | .machineId'
)"

curl --fail --silent --show-error \
  -X DELETE "${PLATFORM_API_URL%/}/vps/${machine_id}" \
  -H "Authorization: Bearer $PLATFORM_SECRET"
```

For the full staging platform plus feature VPS lifecycle, use
[Staging Platform and Feature VPS Runbook](staging-platform-vps.md).
