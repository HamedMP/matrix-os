# S18 CLI compatibility receipt

**Packet:** T090 preservation of the existing 525 CLI collaboration commands. **Date:** 2026-09-21. **Base:** `124/s18-direct-owner-routes` at `3c95e2fa39fabc5bf91d20a5c0c5d5c9f1758d16`. **Code heads:** platform metadata `4264e4aea`; CLI direct transport `bc63329f6`. This child is local and awaits corrected S18 stack linearization; it has not been pushed or submitted.

## Changes

The two code commits change eight files, **+542/−65**, below the 3,000-addition/50-file limit. `GET /api/collaboration/invitations/:invitationId/location` is surviving platform metadata. It uses the exact actor-indexed, still-invited directory row and returns only `{scopeId}`; another actor, an unknown ID, or an accepted invitation gets the same generic 404. It exposes no invitation content, resource name, owner credential, or home data.

The published `@finnaai/matrix` CLI now uses an ephemeral Node Ed25519 key for the frozen v2 protocol: platform-issued scope ticket, owner-home session exchange through the transparent relay, signed HTTP requests, bounded in-memory session reuse and renewal, and one fresh-ticket retry after 401. Session lifecycle requests include the ticket-bound logical runtime header required for opaque relay routing. The platform bearer is used only for metadata and ticket issuance, never for home content. All existing Chat, project, terminal and invitation content commands retain their paths, arguments and output schemas; `inbox`/`shared` remain platform metadata. `terminal-watch` obtains a terminal-purpose ticket, opens `/ws/collaboration/direct/scopes/:scopeId/terminal`, proves possession in its first frame, then runs the existing controller/lease loop. The retired `/connection-tickets` route is removed from the CLI allowlist.

## RED → GREEN

- The invitation metadata route test first returned **404 instead of 200** for the indexed invitee. After implementation, its exact-target, other-actor, unknown-ID, unauthenticated, and accepted-state checks passed.
- The new CLI protocol suite first failed to import the missing Node adapter. The command suite then had **6 failures/3 passes** while content still went to the platform bearer path. The terminal test timed out before a socket opened because it still requested the old ticket route. A separate allowlist RED asserted `true` for the retired `/connection-tickets` path.
- The production Hono journey failed at ticket exchange with a generic 404 before the logical runtime header was added. Its GREEN run passes through actual `CollaborationRelay`, `createDirectSessionRoutes`, `createCollaborationRoutes`, authority and signed request verification; the old platform content proxy receives zero calls.

Final root command: `pnpm exec vitest run tests/cli/collaboration-direct-home.test.ts tests/cli/collaboration-direct-transport.test.ts tests/cli/collaboration-terminal.test.ts tests/platform/collaboration-routes.test.ts --maxWorkers=2` — **4 files, 16/16 passed**. Sync-client command: `pnpm --filter @finnaai/matrix exec vitest run tests/unit/collaboration-command.test.ts --maxWorkers=2` — **9/9 passed**. `pnpm --filter @finnaai/matrix build` and `pnpm --filter @matrix-os/platform exec tsc --noEmit -p tsconfig.typecheck.json` exited 0. `bun run check:patterns` exited 0 with zero violations and five existing warnings. `git diff --check` was clean before commit.

## Environment and release limits

- **Database:** The platform actor-index test and actual Hono owner-home route journey used isolated PGlite fixtures. This layer adds no migration, DB write race, or lease implementation. Real-Postgres migration/cutover/lease evidence belongs to the S18 integrated suites; no real-Postgres result is claimed here. Rollback is a code revert before or after S18 stack integration; the metadata route is read-only and existing owner rows remain authoritative.
- **Host and transport:** The Hono journey uses real route registration and Ed25519 verification in process behind the transparent relay. A second protocol simulator verifies renewal, denial without platform fallback, the terminal-purpose ticket and handshake proof. Physical two-home networking, a packaged CLI against live owner machines, provider execution, and live terminal I/O were **not run**. No approved customer credentials were used.
- **Surfaces:** No React or OS view component changed. Web Canvas, Web Desktop and Electron Desktop were not interactively probed by this CLI packet. Their separate browser direct-client relay-header correction is a coordinator-owned integration gate.

## Integration gate

Rebase this child after the final direct-owner/relay and platform T090 retirement layers, then run the focused CLI and actual Hono suites on the combined head. The coordinator must keep the invitation-location route among surviving platform metadata paths. The T092 physical two-home dry run and S19 release acceptance remain separate gates; this receipt does not claim either complete.
