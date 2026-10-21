# Managed feature activation reconciliation

## Goal

Activate funded AI on the 93 explicitly authorized eligible customer computers and ensure funded AI and dictation are configured for every new eligible customer computer. Existing provider choices, owner files, policy, balances, grants and reservations remain authoritative and unchanged.

## Implementation units

- U1 — Host activation. Own `packages/contracts/src/funded-host-activation.ts`, its index export, `packages/gateway/src/funded-host-activation.ts`, focused gateway tests, `distro/customer-vps/host-bin/matrix-configure-funded-ai.py`, focused real-file Python tests, and the thin route registration in `packages/gateway/src/server.ts`. Add a strict, bounded, operator-authenticated configuration endpoint. Validate live platform policy using the presented machine-scoped funded token before a root-owned atomic host-env update. Missing local epoch can be initialized only from the platform's authenticated current identity; a present different epoch fails closed. Busy gateways defer; unchanged configuration never restarts. Write failing tests first, including malformed/auth/identity/epoch/policy/busy/error cases and real atomic file operations.
- U2 — Platform reconciliation. Own new focused platform eligibility/activation modules, their tests, platform composition wiring, customer VPS operator route callback, release workflow and maintenance helper tests. Add a read-only activation-configuration route authenticated by the current funded runtime token and exact primary identity. Only running authorized customer-primary machines with current enabled global/runtime ordinary-model policy qualify; deletion and unresolved financial obligations defer. No grant, reservation or credential issuance occurs. A bounded nonoverlapping background worker independently reconciles funded AI and speech, retries unavailable/busy hosts, and shuts down cleanly. Release verification runs independently of failed deployments. Write failing tests first.
- U3 — New-user parity and docs. Own `tests/platform/customer-managed-features-onboarding.test.ts`, focused provisioning fixture helpers if needed, and public-safe deployment documentation. Exercise real provisioning/config/template wiring for clean-image, snapshot and recovery paths with both features enabled and identity-bound credentials. Test disabled policy/config gates. Document automatic retries and eligibility boundaries. Update public site documentation in a separate private-site PR if customer-facing documentation changes are needed.
- U4 — Operator rollout and verification. Coordinator only. Refresh the exact 93-target cohort and current eligibility. Deploy the reviewed immutable bundle through scoped platform rollouts, verify loaded configuration and normal funded inference on each target, verify speech remains ready, validate fresh provisioning, and retain aggregate evidence. No bulk credit changes. Remove completed worktrees after merged-head/clean/process checks.

U1 and U2 use the shared wire contract below; U3 touches independent tests/docs. Workers must not stage or commit, revert others' changes, or run the full suite. Coordinator handles combined tests, review and shipping.

## Wire and authentication matrix

Shared request: `{contractVersion:1, identity:{handle,machineId,ownerId,runtimeSlot:"primary",runtimeTokenEpoch}, configuration:{enabled:true,platformOrigin:"https://app.matrix-os.com",relayOrigin:<untagged production Matrix relay HTTPS origin>,runtimeToken:<64 hex>}}`. All objects strict, strings bounded. Shared platform response adds `issuedAt` and `expiresAt`, a maximum 30-second validity window.

| Route | Authentication and authority | Public |
| --- | --- | --- |
| GET `/internal/containers/:handle/ai/activation-config?runtimeSlot=primary` | Exact current machine-scoped funded runtime bearer; identity/epoch and enabled policy rechecked in read-only database transaction | No |
| GET/POST `/api/internal/platform-funded-ai/config` | Existing constant-time per-host operator upgrade bearer; POST validates the exact fresh configuration from the fixed platform route before applying; body limit 4096 | No |
| POST `/vps/managed-features/activate` | Existing platform operator bearer; bounded cursor/handle target schema; no arbitrary configuration supplied by caller | No |

Host GET returns `{configured,configurationRevision}`. Revision hashes machine ID, slot, epoch, platform origin, relay origin and runtime token with NUL separators. POST returns configured or restarting; failures use generic errors. Gateway idle callback includes legacy dispatcher queue/active count and canonical Chat active count. A delayed gateway restart applies process configuration; safe deferral is retried. The root helper touches only five managed assignments (four funded settings and an absent authoritative epoch), serializes the environment write, rejects concurrent updater/rotation markers and custom origins, preserves all unrelated bytes, backs up exclusively, rechecks the file before atomic replacement, caps retained backups and cleans temporary files. Existing host ownership/admin assumptions remain unchanged.

## Verification

Focused TDD suites must cover policy and identity isolation, current token epoch, readonly/no-money behavior, bounded paging/failure isolation, retry after deployment failure, worker startup/stop/drain, fresh clean/snapshot/recovery configuration, and both features together. Run repository CI, independent sensitive-surface review and Greptile 5/5. Production evidence must distinguish configuration from paid model execution. Operator reports remain aggregate-only.
