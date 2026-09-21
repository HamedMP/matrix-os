# S18 browser direct-session relay routing receipt

- Branch: `124/s18-ui-relay-header`, based on assembled release probe `dcfd32b94`.
- Scope: session exchange, renewal, owner-runtime exchange and close through the platform relay. This is a corrective layer for T090 route retirement; no legacy serving route was removed here.
- Source of truth: the signed ticket or established session supplies the logical runtime ID. The relay uses that exact ID only to select the owner home, which verifies the ticket and request proof. The browser does not send platform bearer credentials to the owner home.

## RED → GREEN

| Check | RED | GREEN |
| --- | --- | --- |
| Real `CollaborationRelay` in the browser client path, with a signed fake owner home | 1 failed: session exchange returned `CollaborationDirectError: Collaboration resource not found` (relay 404, missing runtime header) | `tests/ui/collaboration-direct-client.test.ts` 10/10; session exchange, renewal and close traverse the relay runtime directory |
| Owner-runtime session header and signed requests | Header absent before fix | `tests/ui/collaboration-owner-runtime-client.test.ts` 2/2, including the exact logical runtime header |
| Relay routing rules | Existing route tests | `tests/platform/collaboration-relay.test.ts` 9/9 |
| UI TypeScript | Initial implementation found missing `runtimeId` in a helper's structural type | `pnpm --filter @matrix-os/ui exec tsc --noEmit` exit 0 after correction |

The combined focused suite passed **21/21** on 2026-09-21. The in-process relay test uses a signed fake home; physical two-home TLS, live owner runtime, provider, and Clerk probes remain **unrun**. The broader assembled S18 cutover matrix passed 55/55 on real Postgres before this browser-specific layer; that result is not claimed for this branch.
