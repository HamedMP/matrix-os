# S18 T090/T091 follow-up receipt — direct-only gateway startup

**Date:** 2026-09-21. **Base:** corrected release probe `62294c4dc`. **Branch:** `124/s18-gateway-direct-config`. **RED commit:** `59268d9a0`. **GREEN commit:** `4af6fd744`. This is a local child pending release-stack ancestry; no push, PR, merge, deployment, or live-host probe occurred.

## Change and boundary

- The production gateway loader no longer reads or requires `MATRIX_COLLABORATION_ACTIVE_KEY_ID` or `MATRIX_COLLABORATION_PROOF_KEYS`. It requires runtime identity, platform URL, owner database, and a service token. The owner Postgres runtime identity supplies the local Ed25519 identity; fresh platform verification keys arrive over the control stream. Direct ticket exchange still fails closed without a fresh control snapshot or allowed client origin.
- A production-loaded config gives the V1 actor-proof verifier an empty keyring. Even if old proof-key environment variables remain on a host, a correctly HMAC-signed V1 proof is rejected. The config type retains optional proof keys for isolated legacy route fixtures that directly construct the runtime; those fixtures are not production startup. This child does **not** retire the remaining V1 route modules or claim the full T090 replacement is complete.
- No schema, transaction, migration, or external service behavior changed. Rollback to a gateway build that requires V1 keys needs those keys provisioned for that old build; no rollback was run.

## RED → GREEN

| Gate | Observed result |
| --- | --- |
| RED `pnpm exec vitest run tests/gateway/collaboration-direct-only-config.test.ts --maxWorkers=2` | 2/2 failed: direct-only health returned `signing_configuration_missing`, and the loader exposed V1 `proofKeys` when old environment values were present. |
| GREEN focused `pnpm exec vitest run tests/gateway/collaboration-direct-only-config.test.ts tests/gateway/collaboration-org-precondition.test.ts tests/gateway/collaboration-wiring.test.ts tests/gateway/system-info.test.ts tests/gateway/collaboration-confirmation-key.test.ts --maxWorkers=2` | 5 files, 59/59 passed on PGlite fixtures. A later focused rerun after asserting control-client construction passed 2/2. |
| Static gates | `pnpm exec tsc --noEmit -p packages/gateway/tsconfig.json --pretty false`: exit 0. `/home/nima/.bun/bin/bun run check:patterns`: 0 violations, 5 existing warnings. `git diff --check`: exit 0. |

**Unrun:** real Postgres was not needed for configuration-only behavior; no installed owner home, live platform control stream, deployment, or live rollback was tested. This receipt does not claim direct ticket exchange success against a live platform.
