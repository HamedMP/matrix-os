# Company Brain Brief

The daily brief of one project scope, plus its conflicts and stale data. Spec: `specs/561-company-brain-brief/spec.md`;
contract: `../contracts/brief.ts`; tests: `tests/gateway/brain-brief-*.test.ts` (PGlite, fake timers, no network).

## Scope

- Owns `brain_brief_briefs` and `brief/`; reads the core tables with plain SELECTs through `repository.kysely`, never
  writing, altering or indexing one. `index.ts` exports the bootstrap, `createBrainBrief` (service, runner, `brief`
  listener), routes, scheduler, scope lister and summary factories, `briefSummaryEnabled`; cites: `brain/cite.ts`.
- Routes under `/api/brain/projects/:projectId/` (spec: Routes): principal first, brain on, the ref shape, the
  resolver's owner-scoped lookup (missing, foreign and malformed projects: one 404), strict zod, fixed error bodies.

## Source Of Truth

- Briefs, conflicts and stale items are derived from current claims and documents at read time; a past brief reads
  them as of its window's end (`reads.ts` `documentsAsOf`). A stored brief is a snapshot of `(scope, date, window)`.
  In memory: only the scheduler's timer, abort controller and running pass, and the runner's resume position.

## Concurrency And Recovery

- Writes take `pg_advisory_xact_lock(hashtext(owner), hashtext('brain-brief:' || scope))` (5 s lock, 15 s statement
  timeouts), never the core `brain:` lock; the upsert keeps the copy generated last, after checking that its cited
  documents and named sources are live. Reads take no lock; a line whose document goes away mid-read is dropped.
- GETs, passes, `documents_changed` and `scope_erased` delete copies citing deleted documents. A pass has a time budget
  and an abort signal, shares the two-build cap, starts at the scope the last one stopped on, skips gone projects and
  rebuilds day copies of the last `BRIEF_FINISH_DAYS` built before their day ended, so a failed one is retried.
