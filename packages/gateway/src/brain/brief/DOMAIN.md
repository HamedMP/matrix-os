# Company Brain Brief

The daily brief of one project scope, plus its conflicts and stale data. Spec: `specs/561-company-brain-brief/spec.md`;
contract: `../contracts/brief.ts`; tests: `tests/gateway/brain-brief-*.test.ts` (PGlite, fake timers, no network).

## Scope

- Owns `brain_brief_briefs` (stored briefs) and `brief/`. Reads the core tables (sources, documents, revisions, refs,
  receipts, claims) with plain SELECTs through `repository.kysely`; never writes, alters or indexes one.
- `index.ts`: `bootstrapBrainBriefDatabase`, `createBrainBrief` (service, runner, `brief` listener), the routes,
  scheduler, scope lister and summary provider factories, `briefSummaryEnabled`. Cites come from `brain/cite.ts`.
- Routes under `/api/brain/projects/:projectId/` (spec: Routes): principal first, brain on, the ref shape, the
  resolver's owner-scoped lookup (missing, foreign and malformed projects: one 404), strict zod, fixed error bodies.

## Source Of Truth

- Briefs, conflicts and stale items are derived from current claims and documents at read time; a past brief reads
  them as they were at its window's end (`reads.ts` `documentsAsOf`). A stored brief is a snapshot for `(scope, date,
  window)`: at most 60 per scope, newest date first, each at most 256 KiB of JSON. `stored: true` only when the row
  holds it after the write and the scope still holds a source or document row; a scope with neither gets its empty
  brief rebuilt on each read. No in-memory state but the scheduler's one timer, abort controller and running pass.

## Concurrency And Recovery

- Writes take `pg_advisory_xact_lock(hashtext(owner), hashtext('brain-brief:' || scope))` with `lock_timeout 5s` and
  `statement_timeout 15s`, never the core `brain:` lock; the upsert keeps the copy generated last and prunes in the
  same transaction, after checking that the scope still holds a source or document row, every cited document is live
  and every named source has a row, so a build that outlives an erase stores nothing, even one that cites nothing.
- Reads take no lock; a line whose document goes away mid-read is dropped. A GET deletes a copy citing a deleted
  document only while the row still holds it; `scope_erased` deletes a scope's briefs; passes and `documents_changed`
  events delete tombstone citers. A pass is bounded by `BRAIN_BRIEF_SCHEDULE.passBudgetMs` and an abort signal
  (checked before each build), shares the two-build cap, skips a scope whose project is gone, logs failures by name
  and rebuilds day copies of the last `BRIEF_FINISH_DAYS` built before their day ended, so a failed one is retried.
