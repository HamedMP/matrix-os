# S18 rollback proof follow-up

**Task:** T088/T089 compatible-direct recovery guard. **Base:** `3fed4e3ac` (combined S18 gateway/platform integration). **Code head:** `01d021c07`. The receipt commit follows this code head. This branch is not submitted or merged.

## Change and boundary

The platform cutover coordinator now requires a fresh installed-build verifier as well as the operator's compatible-direct assertion before signing a rollback command. An absent, failed or throwing verifier denies the compatible rollback before contacting the owner home; the disabled/fenced recovery path remains available. Production composition resolves the exact enrolled running machine and owner, reads its `/api/system/info` over the existing pinned VPS dispatcher with bearer authentication, a ten-second timeout, no cache, no redirects and a 32 KiB response cap, then requires the running code's direct protocol marker and a version, commit and SHA-256 match to `host_bundle_releases`. The home still independently checks the signed command and target generation. The protocol marker is reported by gateway system info from running code.

Changed files: `packages/platform/src/collaboration/{cutover,compatible-build,bootstrap}.ts`, `packages/gateway/src/system-info.ts`, `tests/platform/{collaboration-cutover-postgres,collaboration-compatible-build}.test.ts`, and `tests/gateway/system-info.test.ts`.

## RED and GREEN

- RED on real PostgreSQL: with `/tmp/matrix-os-124-postgres.env` sourced, `pnpm exec vitest run tests/platform/collaboration-cutover-postgres.test.ts --maxWorkers=2 -t "rejects a caller assertion of compatibility"` failed 1/1: the asserted-true rollback resolved to an `active` journal with `rollbackMode: compatible_direct` without any installed-build verification.
- RED verifier suite: `pnpm exec vitest run tests/platform/collaboration-compatible-build.test.ts --maxWorkers=2` failed at import because `compatible-build.js` did not exist; no tests collected.
- GREEN on real PostgreSQL: with the same environment sourced, `pnpm exec vitest run tests/platform/collaboration-cutover-postgres.test.ts --maxWorkers=2` passed **15/15** (7.00 s). This includes the new caller-assertion denial and existing journal, failure, rollback, disposition and ticket cases.
- GREEN local: `pnpm exec vitest run tests/gateway/system-info.test.ts tests/platform/collaboration-compatible-build.test.ts --maxWorkers=2` passed **34/34**. Verifier cases reject missing protocol, wrong owner machine, mismatched release digest/commit, offline machine and absent published record.
- `pnpm exec tsc --noEmit -p packages/platform/tsconfig.json` and `pnpm exec tsc --noEmit -p packages/gateway/tsconfig.json` both exited 0. `/home/nima/.bun/bin/bun run check:patterns` exited 0 with zero violations and five existing warnings after the timeout was made explicit.

## Recovery evidence and limits

The Postgres tests use isolated schemas in the shared test database. The production verifier was tested with an authenticated-response fixture; **no installed customer host, published live bundle, real release probe or live compatible rollback was exercised**. These remain S18 release acceptance gates. No migration or deployment was performed in this layer. A failed proof leaves the direct generation active; the separate disable path can fence it for recovery. Legacy platform content routes were not removed here pending a proven direct route replacement and the CLI compatibility decision.
