# S18 T090 platform route retirement map

**State on this child:** tests and audit only. The platform legacy proxy, V1 ticket issuer, and WebSocket proof bridge still serve requests. Their removal awaits the direct owner-route authorization fix and a decision about the existing CLI consumer. This child is not a release pass.

| Old route or path | Direct replacement | Retirement condition |
| --- | --- | --- |
| `GET/POST/PUT/PATCH/DELETE /api/collaboration/scopes/:scopeId/*`, including Chat, discussion, grants, project, files, apps, terminal, layout, lifecycle, operations and exports | Same resource path through `CollaborationRelay`, carrying a signed direct-session request to the owner home | Every owner gateway handler accepts a valid direct session and rejects actor proof alone; no live client depends on the old path without a session header. |
| `POST /api/collaboration/runtimes/:runtimeId/catalog/resolve`, `/scopes/preflight`, `/scopes` | Same paths through the direct owner-runtime relay and home authorization | Owner-runtime direct session is bound to the exact organization and home; old HMAC proof branch is retired. |
| `GET/POST /api/collaboration/invitations/:invitationId/*` | Same paths through the direct relay and pending-grant session | Direct pending invitation route enforces organization, scope, runtime and generation binding. |
| `POST /api/collaboration/scopes/:scopeId/connection-tickets` | `POST /api/collaboration/connections` then direct-session creation at the owner home | All applicable clients use the direct ticket; old per-scope ticket issuance returns 404. |
| `/ws/collaboration/scopes/:scopeId/events` and `/terminal` | `/ws/collaboration/direct/scopes/:scopeId/events` and `/terminal` through the opaque relay; home checks the ticket | Old upgrade path is destroyed; malformed collaboration upgrades are destroyed; unrelated personal WebSocket routing is retained. |

Metadata and control paths retained on platform: `/api/collaboration/inbox`, `/shared`, `/api/collaboration/connections`, `/owner-runtime/connections`, `/internal/collaboration/directory`, `/participants/:actorId`, `/participants/resolve`, `/runtime-endpoints`, and `/internal/collaboration/control`. Organization membership/control and cutover command routes remain. Unrelated personal `/api` and WebSocket routes remain.

## Consumer audit and current evidence

- Web Canvas, Web Desktop and Electron Desktop use `packages/ui/src/collaboration/direct-client.ts` through shared adapters. The S05 two-home in-process E2E passed 4/4 in this same combined ancestry: direct routing to resource home, forged ticket rejected at home, generic owner endpoint blocked, and partitioned lease expiry. A route-level platform test passed for a direct session header with no platform proof; `collaboration-relay.test.ts` passed 9/9 and the S18 real-Postgres signed cutover fullstack passed 2/2.
- `packages/sync-client/src/cli/commands/collaboration.ts` still issues old per-scope tickets, sends content requests without direct-session headers, and opens the old terminal WebSocket. `shell/e2e/shared-chat.spec.ts` mocks the old ticket route. Spec 124 defers CLI parity while requiring existing 525 Chat/terminal to keep working; the coordinator is resolving this compatibility gate. The CLI cannot be silently made unavailable or migrated as part of this audit.
- RED after the tests in this child: `collaboration-wiring.test.ts` observed legacy content GET **200 vs expected 404**; `collaboration-routes.test.ts` observed old per-scope ticket **201 vs expected 404** while its direct relay case passed; `collaboration-websocket-retirement.test.ts` observed the required retirement classifier absent. The WS suite needs `pnpm --filter @matrix-os/observability build` before import.
- Gateway owner routes still accepted V1 proof and rejected valid direct sessions in W3's 11-case real-Postgres RED suite. W3 owns the gateway fix in a separate child. Platform production retirement must follow its GREEN result and the CLI decision.

The exact S18 live-host relay/cutover and rollback drill remains unrun. No external host, provider, deployment or user data was changed by these tests. T091 integration/sync fallback inventory is owned by the coordinator in a separate child.
