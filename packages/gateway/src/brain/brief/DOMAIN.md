# Company Brain Brief

The daily brief of one project scope, plus its conflicts and stale data. Spec: `specs/561-company-brain-brief/spec.md`;
contract: `../contracts/brief.ts`.

## Scope

- Owns `brain_brief_briefs` (stored briefs) and `brief/`. Reads the core tables (sources, documents, revisions, refs,
  receipts, claims) with plain SELECTs through `repository.kysely`; never writes, alters or indexes one.
- Out of scope: a summary model (only the seam and flag ship), its spend, organization scopes, delivery to chat or mail.

## Source Of Truth

- Briefs, conflicts and stale items are derived from current claims and documents at read time; a past brief reads
  them as they were at its window's end. A stored brief is a snapshot for `(scope, date, window)`: at most 60 per
  scope, newest date first, each at most 256 KiB of JSON. `stored: true` only when the row holds it after the write.
- No in-memory state besides the scheduler's one timer, one abort controller and one running pass.

## Public API

- `index.ts`: `bootstrapBrainBriefDatabase`, `createBrainBrief` (service, runner, `brief` listener), the routes,
  scheduler, scope lister and summary provider factories, `briefSummaryEnabled`. Cites come from `brain/cite.ts`.
- Routes under `/api/brain/projects/:projectId/`: GET and POST `brief`, GET `conflicts` and `stale` (spec: Routes).

## Auth And Trust Boundaries

- Routes: principal first (`deps.getPrincipal`), then brain on, the project ref shape and the resolver's owner-scoped
  lookup; missing, foreign and malformed projects are the same 404. Strict zod (`exactQuery`, 1 KiB POST body), again
  in the service for agent tools. Clients see only `{ error: { code, message } }` with fixed messages.
- Summary input (flag on, model wired): texts of lines citing only git documents; no ids, cites or permalinks.

## Concurrency And Recovery

- Writes take `pg_advisory_xact_lock(hashtext(owner), hashtext('brain-brief:' || scope))` with `lock_timeout 5s` and
  `statement_timeout 15s`, never the core `brain:` lock; the upsert keeps the copy generated last and prunes in the
  same transaction, after checking that every cited document is live and every named source has a row.
- Reads take no lock (but a GET deleting a copy citing a deleted document); a line whose document goes away mid-read is
  dropped. `scope_erased` deletes a scope's briefs; passes and `documents_changed` events delete tombstone citers.
- A pass is bounded by `BRAIN_BRIEF_SCHEDULE.passBudgetMs` and an abort signal (checked before each build), shares the
  two-build cap, skips a scope whose project is gone, logs failures by name and rebuilds day copies of the last
  `BRIEF_FINISH_DAYS` built before their day ended, so a failed rebuild is retried.

## Tests

`pnpm exec vitest run tests/gateway/brain-brief-*.test.ts`: PGlite, `tests/gateway/helpers/brain-brief-fixture.ts`, fake
timers for the scheduler, no network.
