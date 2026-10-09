# Company Brain Brief

The daily brief of one project scope, plus its conflicts and stale data. Spec: `specs/561-company-brain-brief/spec.md`;
contract: `../contracts/brief.ts`; tests: `tests/gateway/brain-brief-*.test.ts` (PGlite, fake timers, no network).

## Scope And Source Of Truth

- Owns `brain_brief_briefs` and `brief/`; reads core tables with plain SELECTs, never writing, altering or indexing one.
  `index.ts` exports the bootstrap, `createBrainBrief` and the route, scheduler, lister and summary factories.
- All derives from core tables at read time (a past brief as of its window's end: `documentsAsOf`); a rebuild keeps
  lines of claims deleted since. In memory: the scheduler's timer, controller and pass; the runner's last try per scope.

## Concurrency And Recovery

- Writes take the `brain-brief:<scope>` lock (5 s lock, 15 s statements), never the core `brain:` lock; the upsert keeps
  the latest copy, its cites and sources live. Reads take no lock; a line whose document goes mid-read drops.
- GETs, passes, `documents_changed` and `scope_erased` delete copies citing deleted documents. A pass (time budget,
  abort signal, the two-build cap) takes scopes tried least lately first (then stalest brief), skips gone projects and
  rebuilds day copies of the last `BRIEF_FINISH_DAYS` built before their day ended.
