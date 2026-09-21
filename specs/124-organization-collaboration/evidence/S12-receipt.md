# S12 receipt — direct resources, streams, uploads, and scoped apps (T060–T064)

**Packet:** S12. **Date:** 2026-09-21. **Parent:** `124/s09` at `f90627de4` when the two layers were cut. **Base layer:** `124/s12` at `2be1403fe` before this receipt. **App layer:** `124/s12-app` at `ace123611` before this receipt. Graphite restacks can change these SHAs; the PR heads are authoritative afterward. T063 remains deferred by the release plan.

## Layers and changed files

| Layer | Task coverage | Diff vs parent before receipt | Main files |
| --- | --- | --- | --- |
| `124/s12` | T060, T061, T062, T064 policy seam | 30 files, +2,779 / −28 | `contracts/src/collaboration-resources.ts`; gateway `resource-catalog.ts`, `resource-actions.ts`, `resource-routes.ts`, `owner-resource-driver.ts`, `resource-stream.ts`, `upload-stages.ts`, `app-instance-adapter.ts`, `project-app-adapter.ts`, `database{,-migrations}.ts`, `wiring.ts`, `server.ts`; platform directory database/repository; direct policy, driver, stream, wiring, platform and UI tests |
| `124/s12-app` | T064 transactional app bridge and production registration | 3 files, +245 / −3 before receipt | gateway `scoped-app-bridge.ts`, `server.ts`; scoped bridge Postgres test |

The base provides a bounded owner-local catalog, version 12 owner Postgres migration, direct file and folder actions, streams, resumable uploads, standalone Chat/terminal preset checks, and a fail-closed app adapter. The child registers the owner app catalog with a scoped transaction bridge and resolves app assets from a uniquely registered app manifest. No `/chat/requests*` or `/chat/approvals*` endpoints were added; S09 owns them.

## RED → GREEN

Tests were committed ahead of the implementation in `f458ad74f`, `4c17e63c3`, `a85733b3a`, `c78c99f50`, and `e6cfd6e21`. The RED commands exposed missing catalog/stream/upload/bridge services and failing direct policy assertions. The original RED terminal output was not retained, so exact RED counts cannot be quoted. These test commits precede the implementation commits in Git history; no RED pass is claimed.

| Command / evidence | GREEN result |
| --- | --- |
| `CHAT_TEST_DATABASE_URL` and `MATRIX_TEST_POSTGRES_URL` sourced from the local protected test env; `pnpm exec vitest run tests/gateway/direct-resource-policy-postgres.test.ts --maxWorkers=2` | **19/19 passed** on real Postgres, 62.25 s. Covers fresh same-base writes, scope revocation, standalone Chat/terminal presets, file/folder identity, uploads, cancellation, expiry sweep, checksums and app Viewer/Contributor access. |
| `pnpm exec vitest run tests/gateway/direct-resource-policy-postgres.test.ts -t "rejects empty chunks" --maxWorkers=2` | **RED:** `expected 200 to be 400` for an empty part at line 544; 1 failed, 19 skipped. **GREEN:** 1 passed, 19 skipped on PGlite and again on real Postgres after a maximum of 8,192 nonempty parts was enforced. |
| `pnpm exec vitest run tests/gateway/collaboration-scoped-app-bridge-postgres.test.ts --maxWorkers=2` | **3/3 passed** on PGlite, 6.52 s. |
| Same bridge command with protected real Postgres env | **3/3 passed** on real Postgres, 523 ms test time. Covers owner transaction participation, rollback, forged namespace and unregistered table/schema rejection. |
| `pnpm exec vitest run tests/gateway/collaboration-wiring.test.ts tests/gateway/collaboration-owner-resource-driver.test.ts tests/gateway/collaboration-resource-stream.test.ts --maxWorkers=2` | **17/17 passed** on the split base; wiring 11, driver 3, stream 3. |
| `pnpm exec vitest run tests/ui/chat-collaboration-sharing.test.tsx --maxWorkers=2` | **21/21 passed** after the resource-kind label widening. |
| `bun run typecheck` | **Exit 0** on the full unsplit S12 code, including desktop. Split base and child gateway `tsc --noEmit` also passed. |
| `bun run check:patterns` | **0 violations**, 5 pre-existing warnings. |
| `npx react-doctor@latest shell` | Ran; exit 1 from 240 repository-wide diagnostics, no S12-specific finding established. `npx react-doctor@latest --verbose --scope changed` exited 0, score 87/100, 23 warnings; changed S12 driver/catalog sequential-await warnings are review hypotheses and do not involve React state. |

## Database, host, provider and surfaces

- **Database:** The owner home uses Kysely/Postgres. Version 12 follows S09 version 11. The direct policy and bridge suites above used the real shared test Postgres service; no credentials or address are recorded here. The platform directory constraint migration and focused repository suite passed **8/8** on real Postgres in coordinator commit `dc5562d3a`. Migration application was exercised through tests; a destructive down migration was not run. The version 12 migration is additive, and rollback requires routing old traffic away and retaining its tables for forward recovery until the S18 cutover journal decides removal.
- **Host:** Production gateway composition is compiled and wiring tests pass. Live owner VPS, relay, cross-host transport, and durable restart probes were not run in S12. S18 owns real cutover proof.
- **Provider:** No harness or model provider was invoked. Existing Provider V3 and shared execution seams remain S08/S09-owned.
- **Surfaces:** Gateway policy is shared by Web Canvas, Web Desktop and Electron Desktop; the common React labels compile and 21 UI tests pass. Interactive three-surface parity and Electron evidence remain an S15 acceptance gate. Native Mobile and Web Mobile capability is outside S12 V1 implementation. No visual or live host pass is claimed.

## Invariants and remaining gates

- **Source of truth:** owner Postgres stores the catalog, upload stages/parts, revisions and audit; owner home files store file bytes. Platform Postgres directory kinds are expanded for file/folder/app. App storage uses its registered owner schema through a scoped bridge and owner transaction.
- **Authorization:** every direct action uses the authority's current scope epoch, resource binding and member preset. A grant-only app member can access only that app; Viewer cannot mutate through the app bridge. App assets require a unique registered app manifest and safe owner root. Streams check their lease before and during delivery; stale or revoked leases terminate delivery. No reusable shared storage URL is minted.
- **Transactions and locks:** scope/member checks and catalog/upload mutations run in owner Postgres transactions. Upload stage rows lock with `FOR UPDATE`; final commit verifies every part checksum and the expected catalog revision. The filesystem write occurs during the owner transaction, so a rare later DB failure can leave a file ahead of its catalog revision; S18 reconciliation must retain or repair this orphan state rather than misreport success. App bridge writes share the caller's owner transaction, and the real Postgres test proves rollback.
- **Resource limits and cleanup:** upload size/part count and concurrent stage/commit limits are bounded by contract and service; expired stages and terminal rows are swept, owner temp files are swept with symlink-safe `lstat`, and timers close on runtime shutdown. The stream reader has an exact byte cap and abort path.
- **Deferred:** T063 sync-client transfer/CLI mounts, S09 AI request routes, S15 visual parity, S18 cutover, and S19 acceptance matrix remain open. No paid service, deployment or publication was performed.
