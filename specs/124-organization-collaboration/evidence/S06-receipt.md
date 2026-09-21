# S06 receipt — direct clients and resource discovery (T030–T034)

**Branch:** `124/s06`, parent `124/s08` @ f4c6d3297 (the S20 → S02 → S03 → S04 → S05 → S08 stack on main 5f45b108f). Single layer; the coordinator submits.

## Commits

| Commit | Task | Content |
| --- | --- | --- |
| 5db78054b | T030 | RED: `tests/ui/collaboration-direct-client.test.ts` (module not found) |
| 95303c31a | T031 | `packages/ui/src/collaboration/{direct-crypto,direct-client,direct-streams,direct-api}.ts`, discovery contract (optional `resource`, `home`, `organization_pending`), shared page tolerates metadata-only items |
| 8c3e761f4 | T032 | RED: platform discovery must be metadata-only and list organization-pending shares |
| f044debf3 | T032 | platform `listDiscovery` metadata-only (hydration removed), `collaboration_directory.audience`, `listOrganizationSharesForActor`, gateway outbox `audience` flag, wiring passes `listOrganizationIds` from the S03 projection repository |
| (this) | T033/T034 | shell + Electron factories use the direct client, session close on sign-out/auth change, hygiene tests |

## What the client does (T031)

- Per scope: Web Crypto Ed25519 proof key (non-extractable, in memory only) → `POST {platform}/api/collaboration/connections` (actor auth, purpose `direct_session`) → `POST {endpoint.origin}/api/collaboration/direct-sessions?scope=<id>` with possession proof and `clientOrigin`. The origin is the one the directory returned (the relay today); nothing is hardcoded.
- Every request is signed (`protocolVersion 2`, session id, method, canonical path, query, body digest, delete-conditions digest, nonce, issuedAt) and sent with `credentials: "omit"` and no actor token; a 401 triggers exactly one fresh ticket and retry (authority generation change / expiry); 426 → `upgrade_required` without retry; platform 404/503 → `host_offline`.
- Renewal before `renewAfter` with a fresh ticket on the same session and key; renewal failure falls back to a new session. Streams (`events`, `terminal`) open with a purpose ticket in the socket query, send the possession handshake as the first frame, and reconnect only with a new ticket (never a lease extension).
- `createCollaborationDirectApi` keeps the `CollaborationApi` shape: scope and invitation routes go direct (invitation → scope learned from discovery), discovery is fetched from the platform and hydrated from each home (concurrency 4; unreachable home → `home: "offline"`), owner-side create/preflight on the owner's own runtime keep the existing platform path until S18.

## Discovery (T032)

Platform `GET /api/collaboration/{inbox,shared}` return `{scopeId, runtimeId, ownerId, kind, authorityGeneration, status, invitationId?, organizationId?}` only; the proxy-based `hydrate` was deleted from `wiring.ts`/`routes.ts`. `collaboration_directory.audience` (additive column inside the locked bootstrap transaction) is set from the home's directory event `audience: "organization"`, which the gateway outbox derives from an active organization-wide grant (`collaboration_grants`). The inbox's first page appends `organization_pending` items for the actor's current organizations (S03 `listOrganizationsForActor`) that have no user-index row for the actor and are not owned by them.

Gap recorded: opening an `organization_pending` item still fails at the home until S12/S15 mount the S04 activation route and the platform ticket issuer admits organization-pending members (today `getScopeActorStatus` has no row → denied). The shared page renders the item with an Open control that will work once those land.

## Wiring (T033)

- `shell/src/lib/collaboration.ts`: `createShellCollaborationApi` → direct API (platform is same-origin as the shell; cookies via `same-origin` only on platform calls). `clearMatrixAppSession()` closes every direct session first.
- `desktop/src/renderer/src/lib/collaboration.ts`: same client; `clientOrigin` = platform origin (the renderer is `file://`/dev host, not https); `stores/connection.ts` closes sessions on `auth:changed`.
- Coordinator patches: none required. The Electron CSP `connect-src` already contains the gateway/platform origin and its `wss:` form, which is the relay origin in this release; if `MATRIX_COLLABORATION_RELAY_ORIGIN` is ever set to a different host, `buildRendererCsp` must add it (noted under Deferred scope). The gateway WS query-ticket allowlist already admits `/ws/collaboration/direct/...` (S05).

## Tests (observed)

- RED T030: `pnpm exec vitest run tests/ui/collaboration-direct-client.test.ts` → 1 failed file, module not found (5db78054b). GREEN: 9/9.
- RED T032: `tests/platform/collaboration-routes.test.ts` → 3 failed (8c3e761f4). GREEN: 7/7; wiring/outbox characterizations updated for metadata-only discovery and the audience flag (outbox expectation also gained `organizationId`, which S20 layer 3 seeds but had not asserted).
- T034: `tests/ui/collaboration-direct-hygiene.test.ts` 4/4, `tests/shell/collaboration-direct-wiring.test.ts` 2/2, `tests/desktop/collaboration-direct-wiring.test.ts` 2/2.
- Regression sweep (17 files / 144 tests): platform routes, wiring, bootstrap, relay, tickets, internal routes, proxy, websocket; gateway outbox, direct sessions; ui client/sharing/state/project sharing; desktop chat sharing runtime; contracts collaboration + direct.
- `bun run typecheck` exit 0; `bun run check:patterns` 0 violations (5 pre-existing warnings); react-doctor `packages/ui`: 44 pre-existing issues, none on the lines changed here (see PR body).
- Full `bun run test` not run (host-load rule); CI covers it after retarget.

## Evidence status

The shared page gained two card states (home offline / access unavailable, organization pending). Screenshots were NOT captured in this environment (no shell stack run; the earlier S20 capture needed a 4 GB heap and a quiet host). The PR body states this explicitly; capture per `evidence/S20-audience/README.md` before review-readiness.

## Ownership for later packets

- S12/S15: mount activation for `organization_pending` (home route + platform ticket admission), wire file/app routes through `createCollaborationDirectApi` (path-based, no client change needed).
- S18: delete the platform proxy path that owner-side create/preflight still uses; the direct client then covers every route.
