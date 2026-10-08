# Company Brain Brief

The daily brief of one project scope, plus its conflicts and stale data. Spec:
`specs/561-company-brain-brief/spec.md`; contract: `../contracts/brief.ts`.

## Scope

- Owns `brain_brief_briefs` (stored briefs) and everything under `brief/`.
- Reads the core tables (`brain_sources`, `brain_documents`, `brain_document_revisions`,
  `brain_document_refs`, `brain_sync_receipts`, `brain_claims`) with plain SELECTs through
  `repository.kysely`. It never writes, alters or indexes a core table.
- Out of scope: a summary model (only the seam and the flag ship), recording summary spend,
  organization scopes, pushing briefs anywhere (chat, mail).

## Source Of Truth

- Briefs, conflicts and stale items are derived from current claims and documents at read time.
- A stored brief is a snapshot for `(scope, date, window)`; at most 60 per scope, newest date
  first, each at most 256 KiB of JSON. A tombstone removes content: when a document a stored copy
  cites or a source it names was deleted since, GET deletes that copy and rebuilds the date.
  `stored: true` only when the row holds the brief after the write (not over the cap, not older
  than a stored copy, not pruned at once).
- Commitment due dates and assignees: claim fields, else the document's `due` (a real calendar
  day only, `CALENDAR_DATE` in SQL) and `assignee` refs, where trackers such as Linear put them.
- No in-memory state besides the scheduler's one timer, one abort controller and one running pass.

## Public API

- `index.ts`: `bootstrapBrainBriefDatabase`, `createBrainBrief` (service, runner, `brief`
  listener), `createBrainBriefRoutes`, `createBrainBriefScheduler`, `createBrainBriefScopeLister`,
  `createBrainBriefSummaryProvider`, `briefSummaryEnabled`.
- Routes under `/api/brain/projects/:projectId/`: `GET brief?date=&window=`, `POST brief`,
  `GET conflicts?rules=&limit=&cursor=`, `GET stale?kinds=&limit=&cursor=`.
- Files: `sections.ts` (brief sections), `conflicts.ts` (three rules), `stale.ts` (four kinds and
  open commitments), `text.ts` (pure text rules), cites from the shared `brain/cite.ts`,
  `reads.ts` (shared core reads), `database.ts` (table and stored briefs), `service.ts`,
  `scheduler.ts`, `summary.ts`, `paging.ts`, `time.ts`, `routes.ts`, `types.ts`.

## Auth And Trust Boundaries

- Routes: request principal first (`deps.getPrincipal`), then brain on, then the project ref
  shape, then the resolver maps owner and project to the scope. Missing, foreign and malformed
  projects are the same 404.
- Every input is a strict zod schema (`exactQuery` for queries, a 1 KiB body limit on POST);
  the service validates again so direct callers (agent tools) get the same rules.
- Clients only see `{ error: { code, message } }` with fixed messages; logs carry error names.
- Summary input is line text only (no ids, cites or permalinks) and only when
  `MATRIX_BRAIN_BRIEF_SUMMARY` is on and a model is wired. Only lines whose every cite is a git
  document (`BRAIN_MODEL_PROVENANCES`) are sent, the same rule as model claim extraction; chat,
  note, file, calendar, Slack, Linear and GitHub lines never leave the gateway.

## Concurrency And Recovery

- Stored brief writes take `pg_advisory_xact_lock(hashtext(owner), hashtext('brain-brief:' ||
  scope))` with `lock_timeout 5s` and `statement_timeout 15s`; never the core `brain:` lock.
  An upsert keeps the copy generated last; pruning runs in the same transaction.
- Reads take no lock (a GET that deletes a stored copy citing a deleted document takes the brief
  lock for that delete). A document tombstoned between two reads drops the line that cites it.
- Two requests may build the same brief at once; both are valid and the newer one stays.
- The scheduler pass is bounded by `BRAIN_BRIEF_SCHEDULE.passBudgetMs` and an abort signal;
  a failed scope is counted and logged by error name, and the next pass retries it. Its builds
  share the request build cap (two at once), so a pass never adds a third.
- `scope_erased` deletes every stored brief of the scope; nothing else is scope-level. A write
  first checks under the brief lock that every cited document is live and every named source still
  has a row, so a build that outlives a tombstone, an erase or the listener stores nothing. Each
  scheduled pass and every `documents_changed` event (the bus routes it here) deletes stored briefs that
  cite a tombstoned document, and skips a project scope whose project no longer resolves.

## Tests

`pnpm exec vitest run tests/gateway/brain-brief-*.test.ts` (PGlite through
`tests/gateway/helpers/brain-store-helpers.ts`; brief fixtures in
`tests/gateway/helpers/brain-brief-fixture.ts`; fake timers for the scheduler; no network).
