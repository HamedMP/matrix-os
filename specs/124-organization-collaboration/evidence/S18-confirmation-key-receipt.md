# S18 follow-up receipt — home share-confirmation key

**Date:** 2026-09-21. **Base:** `124/release-restack-probe` `e5392e052`. **Branch:** `124/s18-confirmation-key`. **RED test commit:** `c7d49928d`. **GREEN code commit:** `e92ecb8b0`. This is a local child pending release-stack ancestry; no PR, push or merge was made.

## Change and invariants

- Gateway configuration no longer reads or requires `MATRIX_COLLABORATION_PREFLIGHT_SECRET`. At construction it obtains the existing migration-9 Ed25519 runtime identity from the owner's Postgres and derives a distinct 32-byte confirmation HMAC key with HKDF-SHA256, the runtime ID as salt and a versioned domain. Chat, project, terminal, standalone resource and project inventory confirmations all receive that one local key. The seed stays in the owner database and is never sent to the platform or client.
- Source of truth: the existing singleton `collaboration_runtime_identity` row. No new schema or persistence backend. Construction still fails closed if the identity is malformed or unavailable. Confirmation token payloads, revision binding, 60-second expiry and constant-time signature comparison are unchanged. No route, CLI or actor-proof behavior changed.
- Lock/transaction scope: unchanged. `ensureRuntimeIdentity` retains its `ON CONFLICT` first-boot behavior. No new write or external call occurs inside a transaction. No new orphan state.
- Rotation: restart with the same owner database preserves unexpired confirmations. A coordinated runtime-identity rotation and gateway restart invalidates outstanding confirmations for at most their 60-second lifetime; the owner must run preflight again. The runbook records that the new public identity must be registered with the platform and the old seed must not be retained as a confirmation fallback.

## RED → GREEN

| Gate | Observed result |
| --- | --- |
| RED `pnpm exec vitest run tests/gateway/collaboration-confirmation-key.test.ts --maxWorkers=2` | 2 failed: a complete environment without the deployed preflight secret returned `null`; runtime construction passed `undefined` to `CollaborationChatScopeService` and threw at `Buffer.byteLength`. |
| GREEN focused `pnpm exec vitest run tests/gateway/collaboration-confirmation-key.test.ts tests/gateway/collaboration-wiring.test.ts tests/gateway/system-info.test.ts tests/gateway/collaboration-org-precondition.test.ts --maxWorkers=2` | 4 files, 57/57 passed on PGlite fixtures. Restart accepts a still-valid project confirmation; rotated identity rejects the old confirmation. |
| GREEN real Postgres `set -a; source /tmp/matrix-os-124-postgres.env; set +a; pnpm exec vitest run tests/gateway/collaboration-confirmation-key.test.ts --maxWorkers=2` | 1 file, 2/2 passed against isolated schemas on the dedicated test server. No credentials were printed or committed. |
| Static gates | `pnpm exec tsc --noEmit -p packages/gateway/tsconfig.json`: exit 0. `bun run check:patterns`: 0 violations, 5 existing warnings. `git diff --check`: exit 0. |

**Unrun:** no installed owner host or live organization share probe; no deployment or rollback was performed. Rollback to a pre-change gateway build requires provisioning its legacy 32-byte preflight secret before starting that build; this child does not add a live rollout step. No React file changed, so React Doctor was not applicable.
