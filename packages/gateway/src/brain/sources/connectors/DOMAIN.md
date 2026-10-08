# Company Brain connector sources

Linear, Google Drive, Google Calendar and the Slack bridge as brain sources, plus `runBrainSourceSync`, the sync
runner every connectable kind shares. Spec: `specs/560-company-brain-connector-sources/spec.md`.

## Scope

- `handlers.ts`: the four kind handlers. Adapters: `linear.ts` (watermark passes) and `google-drive.ts`,
  `google-calendar.ts`, `slack-bridge.ts` on the snapshot engine (`snapshot.ts`). The runner lives in
  `../core/runner.ts` (spec 565) and `index.ts` re-exports it.
- Out of scope: the `/sources` service and routes (`../core/`), the option lookups, the real integration caller
  (`../integration/`), the registry read actions (`integrations/registry-brain.ts`), the Slack capture reader (waits
  for PR #2078) and schedules.

## Source of truth

- Provider data through `BrainIntegrationCaller` or `BrainSlackCaptureReader`. Core `brain_*` tables are written only
  through `applySyncBatch` and receipts; `brain_connector_sources` holds one config per source (JSONB, 8 KiB, FK to
  `brain_sources` ON DELETE CASCADE). In memory: a capped set of running keys (16) and one bounded plan per run.

## Public API

`index.ts`: `bootstrapBrainConnectorDatabase`, the four `createBrain*Handler` factories, `runBrainSourceSync`, the
Slack capture reader types and `BRAIN_CONNECTOR_LIMITS`.

## Auth and trust boundaries

- Callers authorize the project scope; handlers get an owner id and a scope key, never a request. No credential in
  configs or logs; logs carry names and codes only. Provider data is untrusted and bounded by zod schemas.
- Calendar descriptions and locations only with `includeEventBodies`; a calendar config change deletes stored events
  missing from the listing. The bridge copies `slack_thread` documents of `C` and `G` channels only, and removes every
  copied thread when the owner can no longer read the company scope (then the run fails).
- Accounts: without `isConnected`, or with `isConfigured()` false (no integration transport is bound, so connecting
  an account in Settings would not help), a kind is `not_configured`; with `accounts` a run uses only its pinned
  account label, or the owner's single account, never the first of several (`not_connected` otherwise).

## Concurrency and recovery

- One run per source per process; across processes the cursor compare-and-set decides (`cursor_conflict`). Each page
  commits documents, refs and cursor together. Config writes take the `brain-connector:<scopeId>` lock.
- After a crash the next run closes the receipt as interrupted; Linear resumes its stored provider cursor and
  snapshot adapters re-plan from the store. Every provider call races its timeout, even if the callee ignores it.

## Tests

`pnpm exec vitest run tests/gateway/brain-source-connectors-*.test.ts` (PGlite and fakes; no network).
