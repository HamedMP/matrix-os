# Company Brain connector sources

Linear, Google Drive, Google Calendar and the Slack bridge as brain sources, plus `runBrainSourceSync`, the sync
runner every connectable kind shares. Spec: `specs/560-company-brain-connector-sources/spec.md`. Tests:
`pnpm exec vitest run tests/gateway/brain-source-connectors-*.test.ts` (PGlite and fakes; no network).

## Scope

`handlers.ts` (four kind handlers), `linear.ts` (watermark passes), `google-drive.ts`, `google-calendar.ts` and
`slack-bridge.ts` on `snapshot.ts`; the runner `../core/runner.ts`, re-exported by `index.ts`. Out of scope: the
`/sources` service and routes, option lookups, the integration caller, registry actions, the Slack capture reader.

## Source of truth

Provider data via `BrainIntegrationCaller` or `BrainSlackCaptureReader`. Core `brain_*` tables only through
`applySyncBatch` and receipts; `brain_connector_sources` holds one config per source (JSONB, 8 KiB, FK to
`brain_sources` ON DELETE CASCADE). In memory: a capped set of running keys (16) and one bounded plan per run.

## Public API

`index.ts`: `bootstrapBrainConnectorDatabase`, the four `createBrain*Handler` factories, `runBrainSourceSync`, the
Slack capture reader types and `BRAIN_CONNECTOR_LIMITS`.

## Auth and trust boundaries

- Callers authorize the project scope; handlers get an owner id and a scope key, never a request. No credential in
  configs or logs (names and codes only); provider data is untrusted and bounded by zod schemas.
- Calendar bodies only with `includeEventBodies`. The bridge copies `C`/`G` channel `slack_thread`s only and removes
  every copy when the owner can no longer read the company scope (then the run fails).
- Without `isConnected`, or with `isConfigured()` false, a kind is `not_configured` and its runs fail
  `provider_unavailable`; with `accounts` a run uses only its pinned account label or the owner's single account.

## Concurrency and recovery

One run per source per process; across processes the cursor compare-and-set decides (`cursor_conflict`), and every
page that writes renews its cursor token. Each page commits documents, refs and cursor together; config writes take
`brain-connector:<scopeId>`. After a crash the next run closes the receipt as interrupted and adapters resume from
the stored cursor and documents. Every provider call races its timeout.
