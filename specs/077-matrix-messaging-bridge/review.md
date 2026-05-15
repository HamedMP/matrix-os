# Review: Matrix Messaging Bridge

## Mechanical Sweep

- `bun run check:patterns` completed with 0 violations.
- Existing scanner warnings remain in unrelated shell/platform/app-runtime files.
- Changed messaging routes apply Hono `bodyLimit` middleware to mutating
  endpoints and use bounded Zod schemas at route boundaries.
- `bun run typecheck` completed successfully.
- Focused messaging/deploy/app validation completed successfully: 24 test files,
  69 tests.
- Full `bun run test` did not complete green in this environment. It reported
  failures in `tests/platform/proxy-routing.test.ts` and
  `tests/platform/customer-vps.test.ts`, plus a worker termination timeout in
  `tests/integrations/routes.test.ts`, then was terminated after hanging.

## Trust Boundaries

- Owner scope is resolved once per request through `getOwnerId`.
- Appservice ingestion requires `X-Matrix-OS-Appservice-Token` and constant-time
  comparison before accepting bridge events.
- Client-visible errors use the messaging error mapper and generic messages.
- Recovery and health routes expose coarse status/action results only.

## Atomicity And Failure Modes

- Permission updates are repository-owned and carry optimistic `revision`
  semantics.
- Appservice ingestion dedupes on Matrix homeserver `event_id`.
- Reply sending rechecks room permission at the final dispatch point and uses
  stable client transaction ids.
- Revocation cancels queued/running Hermes work and unsent replies in the
  repository path.
- Operations helpers document 1 hour RPO, 15 minute RTO, and WhatsApp relink
  after stale restore.

## Deferred Scope

- Real Telegram/WhatsApp first-loop validation remains gated on production
  credentials and WhatsApp pairing.
- E2EE key-sharing semantics are not enabled for Hermes delivery in this slice.
- Edits, deletes, reactions, receipts, typing indicators, stickers, voice notes,
  org-shared accounts, and uncapped historical import are deferred.
