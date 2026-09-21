# S18 T090 legacy serving retirement gate (2026-09-21)

This is a preparation receipt, not cutover completion. The child branch is `124/s18-t090-retirement-tests`, based on corrected release probe `dcfd32b94c6d9ac3a8cc6813022f6787a92aa1c2`. No serving route was removed and no live host was contacted.

## Exact platform serving paths on this base

| Path family | Current registration and behavior | Retirement or replacement proof |
| --- | --- | --- |
| HTTP content and mutations, `/api/collaboration/runtimes/:runtimeId/{catalog/resolve,scopes/preflight,scopes}`; `/api/collaboration/scopes/:scopeId/**`; `/api/collaboration/invitations/:invitationId{,/accept,/decline}` | `packages/platform/src/collaboration/routes.ts:69-102` falls back to `CollaborationProxy.forward` for the exact method/path allowlist in `proxy.ts:19-77`. `proxy.ts:121-239` performs directory/policy lookups, buffers bodies, signs V1 actor proof and forwards it. | Direct-session requests use the transparent relay in `routes.ts:72-85`; owner home validates the signed request. Before removing fallback, prove every supported Web Canvas, Web Desktop, Electron Desktop and existing CLI operation uses direct transport. Paths with no direct consumer must return not found, never fall back to V1 proof. |
| V1 socket ticket, `POST /api/collaboration/scopes/:scopeId/connection-tickets` | `routes.ts:128-150` issues a `CollaborationWebSocketAuthorizer` ticket. | Direct session ticket issuance is `/api/collaboration/connections` (and owner-runtime equivalent) in `direct-routes.ts:71-113`. Existing CLI terminal-watch must use direct ticket and socket handshake first. |
| V1 WebSocket, `/ws/collaboration/scopes/:scopeId/{events,terminal}` | `collaboration/websocket.ts:13-16,55-65,79-94` classifies the path and builds a V1 proof header. `platform-websocket-upgrade.ts:265-291,345-353` authorizes and proxies it. | Direct WebSocket `/ws/collaboration/direct/scopes/:scopeId/{events,terminal}` is classified/relayed at `platform-websocket-upgrade.ts:248-264`. Prove CLI terminal-watch and supported UI sockets use it, then reject the old path. |

The exact V1 HTTP allowlist in `proxy.ts:19-77` includes scope/grant/member/policy and user-state operations; Chat/discussion messages and shared AI requests/approvals; terminal state/actions; project inventory/confirmation, files, Git, apps, layout, and creation; plus runtime creation/preflight and invitation access. Treat the whole allowlist as one retirement boundary. Do not remove unrelated personal HTTP/WS proxy behavior or platform metadata/control endpoints. `GET /api/collaboration/inbox|shared`, runtime directory events, participant/identifier metadata lookup, and direct connection issuance remain. The transparent relay remains.

## Consumer and sequence gates

- Existing CLI still calls V1 content, invitation, connection-ticket, and terminal WebSocket paths in `packages/sync-client/src/cli/commands/collaboration.ts:32-88,336-564` on this base. Its direct compatibility adapter is being implemented in a separate child; this preparation branch does not edit it. Existing CLI functionality must remain working during cutover.
- The UI relay correction is also in a separate child. Integrate and prove direct UI requests and CLI journeys first, including old-client/old-home negative behavior and direct owner authorization at the home. Only then make the registration change, remove the proxy and V1 socket authorizer, and run affected route, CLI, UI, and real-Postgres cutover suites.
- Preserve a single coordinated cutover: activated scopes must reject legacy role/proof readers, and rollback must use a compatible direct build or leave collaboration unavailable. No proxy fallback after failed activation.
- The active `MATRIX_COLLABORATION_PREFLIGHT_SECRET` gateway confirmation use was moved to a persisted home-local key in a separate S18 child. The remaining `collaboration_rollout_policy` reference on this base is a `DROP TABLE IF EXISTS` migration in `packages/platform/src/collaboration/database.ts:162`, not an active allow policy.

## Test-first evidence

Command: `pnpm exec vitest run tests/platform/collaboration-legacy-retirement.test.ts --maxWorkers=2`.

Observed RED on this child: **3 failed, 1 passed**. Unsigned `GET /scopes/:scopeId/chat` returned 200 via the V1 proxy instead of 404; V1 `connection-tickets` remained registered; and the old terminal socket remained classified as served. Signed direct-session Chat forwarding returned 200 through the transparent relay and did not invoke the V1 proxy. The RED tests are committed at `2072ce4cee62f3cd998882886bc7b9a1be6a469e`.

No real Postgres was needed for these registration assertions. Green retirement evidence, integrated CLI/UI journeys, a two-home live relay probe, installed-host version proof, migration/rollback dry run, and release CI/review are **unrun** here. This branch must stay intentionally RED until the replacement clients are integrated; it must not be submitted as a green release layer.
