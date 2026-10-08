# Company Brain Brief

The daily brief of one project scope, plus its conflicts and stale data. Spec: `specs/561-company-brain-brief/spec.md`;
contract: `../contracts/brief.ts`.

## Scope

- Owns `brain_brief_briefs` (stored briefs) and everything under `brief/`.
- Reads the core tables (`brain_sources`, `brain_documents`, `brain_document_revisions`, `brain_document_refs`,
  `brain_sync_receipts`, `brain_claims`) with plain SELECTs through `repository.kysely`. It never writes, alters or
  indexes a core table.
- Out of scope: a summary model (only the seam and the flag ship), recording summary spend, organization scopes,
  pushing briefs anywhere (chat, mail).

## Source Of Truth

- Briefs, conflicts and stale items are derived from current claims and documents at read time.
- A stored brief is a snapshot for `(scope, date, window)`: at most 60 per scope, newest date first, each at most
  256 KiB of JSON. `stored: true` only when the row holds the brief after the write.
- Commitment due dates and assignees: claim fields, else the document's `due` (a real calendar day only,
  `CALENDAR_DATE` in SQL) and `assignee` refs.
- No in-memory state besides the scheduler's one timer, one abort controller and one running pass.

## Public API

- `index.ts`: `bootstrapBrainBriefDatabase`, `createBrainBrief` (service, runner, `brief` listener),
  `createBrainBriefRoutes`, `createBrainBriefScheduler`, `createBrainBriefScopeLister`,
  `createBrainBriefSummaryProvider`, `briefSummaryEnabled`.
- Routes under `/api/brain/projects/:projectId/`: `GET brief?date=&window=`, `POST brief`,
  `GET conflicts?rules=&limit=&cursor=`, `GET stale?kinds=&limit=&cursor=`.
- Files: `sections.ts`, `conflicts.ts` (three rules), `stale.ts` (four kinds, open commitments), `text.ts` (pure text
  rules), `reads.ts` (shared core reads), `database.ts` (stored briefs), `service.ts`, `scheduler.ts`, `summary.ts`,
  `paging.ts`, `time.ts`, `routes.ts`, `types.ts`; cites come from the shared `brain/cite.ts`.

## Auth And Trust Boundaries

- Routes: principal first (`deps.getPrincipal`), then brain on, then the project ref shape, then the resolver maps
  owner and project to the scope. Missing, foreign and malformed projects are the same 404.
- Inputs are strict zod (`exactQuery`, a 1 KiB body limit on POST); the service validates again for direct callers
  (agent tools). Clients see only `{ error: { code, message } }` with fixed messages; logs carry error names.
- Summary input (only with `MATRIX_BRAIN_BRIEF_SUMMARY` on and a model wired) is the text of lines citing only git
  documents (`BRAIN_MODEL_PROVENANCES`): no ids, cites or permalinks, and no chat, note, file, calendar or tracker line.

## Concurrency And Recovery

- Stored brief writes take `pg_advisory_xact_lock(hashtext(owner), hashtext('brain-brief:' || scope))` with
  `lock_timeout 5s` and `statement_timeout 15s`, never the core `brain:` lock. The upsert keeps the copy generated
  last (two concurrent builds are both valid); the prune runs in the same transaction.
- Reads take no lock, except a GET deleting a stored copy that cites a deleted document. A document tombstoned
  between two reads drops the line that cites it.
- A write first checks under the lock that every cited document is live and every named source still has a row, so
  a build that outlives a tombstone, an erase or the listener stores nothing. `scope_erased` deletes every stored
  brief of the scope; each scheduled pass and `documents_changed` event deletes those citing a tombstoned document.
- A scheduler pass is bounded by `BRAIN_BRIEF_SCHEDULE.passBudgetMs` and an abort signal and shares the two-build
  cap; it skips a scope whose project no longer resolves and counts, logs by name and retries a failed scope.

## Tests

`pnpm exec vitest run tests/gateway/brain-brief-*.test.ts`, with PGlite and fixtures from `tests/gateway/helpers/`
(`brain-store-helpers.ts`, `brain-brief-fixture.ts`), fake timers for the scheduler and no network.
