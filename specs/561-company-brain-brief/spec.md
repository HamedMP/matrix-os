# Company Brain brief, conflicts and stale data

**Status:** Implementation target (brief layer of the brain stack; builds on specs 551, 552, 553, 554)  
**Owner:** gateway `brain` domain (`brain/brief/`)  
**Date:** 2026-10-02

## Outcome and scope

Each morning the owner can open one deterministic brief of a project: what changed, new decisions and risks, open
commitments and what needs attention, every line citing a document. Conflicts and stale data are also listed alone.
A model summary may come later behind a flag that is off. In scope: `brain/brief/`, four routes, the summary seam,
tests. Out of scope (no stubs): Deferred scope below. OS-view surface matrix: N/A (a JSON API; spec 563 shows it).

## Brief model

- Table `brain_brief_briefs`, key `(owner_id, scope_id, brief_date, brief_window)`, plus `generated_at`, `body` (JSONB
  view without `stored`) and `byte_count`; CHECKs mirror the zod bounds. `bootstrapBrainBriefDatabase` creates it under
  the `brain_brief_schema` lock. Scope-level rows: no document foreign key; `scope_erased` deletes them.
- Windows are UTC on source time (`source_updated_at`; a first sync of old history does not fill today): `day` is
  `[date, +1 day)`, `week` the 7 days ending with it; a future date or one over 365 days back is `invalid_request`. A
  past window sees the brain as it was at its end: documents dated, sources created and receipts finished before it.
- Sections (caps from `BRAIN_BRIEF_LIMITS`; `truncated` when one is hit):
  - changes: live documents dated in the window, grouped by source (label, kind, created = revision 1 or first
    published in the window, revised = the rest), 10 newest items per group, 20 groups, most active first.
  - decisions and risks: current claims first seen in the window: the document is dated in the window at revision 1,
    or the claim was written after its last revision. So a revised spec lists only its new claims.
  - commitments: every open commitment, due date first, then newest. Open: current, not stated done, not on a document
    whose `status` ref is done, completed, closed, merged, resolved, shipped or canceled. A done word is planned after a
    future, need, intent or condition word (`will be shipped`, `we'll`, `once merged`), before a deadline (`completed
    by Friday`) or as the verb `complete`. Closed documents are filtered in SQL; done ones are skipped by reading on in
    pages (at most 10). Due date and assignee: the claim's fields, else the document's `due` (a calendar day) and
    `assignee` refs, where trackers such as Linear put them.
  - attention: up to 10 conflicts (those detected in the window first, then the rest in a daily rotation, so every
    open conflict shows in some brief), then up to 20 stale items per kind, 50 lines in all.
- A line: one-line text (at most 400 characters), 1 to 4 cites (`BrainCiteView`), claim id and kind for a claim, due and
  assignee for commitments, severity for risks; a source line cites its newest live document (none: left out).
- Storage: GET returns the stored copy, rebuilt if built before its window ended and the window has since ended or it
  is an hour old; POST always rebuilds; 60 copies per scope are kept, newest date first. `stored: true`: the row holds
  this brief after the commit (not over 256 KiB, no later copy, under 60 newer ones, every named document and source
  live). GET deletes and rebuilds a copy naming a deleted document; passes and `documents_changed` events delete them.
- Builds and reads are read-only (10 s statement deadline). At most two builds run at once (more: 503), scheduled
  ones included. A pass builds today's brief unless fresh and rebuilds each day copy of the last 7 days built before
  its day ended, so a failed build is retried next pass; it skips a scope whose project is gone and stops on abort.

## Conflicts

Computed on demand, newest side first, each with both sides (cite, claim id, statement, verbatim quote up to 300 chars),
a stable id (`cfl_` + 32 hex of sha256 of the rule and sorted side keys) and `detectedAt`, the newer side's date.

- `label_disagreement`: decision or invariant claims of two documents, same normalized label (not `Deferred scope`),
  with a clause of each on the same content words (0.8 overlap) and opposite negation (`stored`, `never stored`) or
  other numbers (`8 runs`, `16 runs`); same label alone is noise (about 22,000 pairs here). Cross-source pairs go first.
- `draft_spec_shipped`: a spec part 1 whose first status line in its first 40 lines reads Draft, and a merged pull
  request (`git_pr`, or `github_pr` with status `merged`) dated after the spec that references it and changes a path
  outside `specs/`. One conflict per spec, with the first such pull request; 13 specs on this repository.
- `commitment_reversed`: two commitments with the same label (or none) on the same thing (0.5 word overlap without state
  words), one done and one deferred (statement words, else the status ref); the newer one decides the summary.
- Caps (see Resource management) keep a rule near 100 ms; pairs are compared the first rows of every group first.

## Stale data

- `claim_outdated`: a claim of a live document read from an older revision; `since`: when it was replaced.
- `source_sync_old`: an active source with no succeeded or partial receipt for 7 days (from its creation if it never
  synced), `since` when it crossed them; `source_failing`: its newest receipt failed (the text names the code).
- `commitment_overdue`: an open commitment due before today (in a brief, before its date), due as above.
- Newest `since` first, then kind, then id. Source items have `cite: null` and a `sourceId`.

## Routes

Rules of spec 553: principal first, `service === null` is 503, a project id or slug (`BRAIN_PROJECT_REF_PATTERN`),
`exactQuery` then strict zod, `Cache-Control: private, no-store` on every answer, one error mapper, no `app.use`.

| Method, path | Input | Success | Errors |
| --- | --- | --- | --- |
| GET `/projects/:projectId/brief` | `date` (`YYYY-MM-DD`), `window` (`day`, `week`) | 200 `BrainBriefView` | 400 401 404 503 |
| POST `/projects/:projectId/brief` | bodyLimit 1 KiB; empty or strict `{ date?, window?, summary? }` | 200 `BrainBriefView` | 400 401 404 409 413 503 |
| GET `/projects/:projectId/conflicts` | `rules` (comma list), `limit` 1..50 (20), `cursor` | 200 `BrainConflictsView` | 400 401 404 503 |
| GET `/projects/:projectId/stale` | `kinds` (comma list), `limit` 1..50 (20), `cursor` | 200 `BrainStaleView` | 400 401 404 503 |

Paging: an offset cursor (base64url JSON `{v, k, o}`, at most 512 chars); `k` fingerprints the endpoint and filters,
so another query's cursor is `invalid_request`. `summary: true` with no flag or model is 409 `summary_not_configured`.

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| The four routes | `authMiddleware`, `requireRequestPrincipal` | project owned by the principal (resolver); scope `personal:project:<id>` | fixed codes |
| Runner and scheduler | server code | scopes with a live source of the gateway owner | counted, logged by name |
| `scope_erased` listener | server code | the erased scope key | rejects on database errors |

- Input validation: project ref pattern, bodyLimit, strict zod queries and bodies (also in the service for direct
  callers), real calendar dates, bounded lists, strict cursor regex, bound SQL parameters only. Credentials: none.
- Error policy: `{ error: { code, message } }` with fixed messages (`BRAIN_API_ERRORS`, `BRAIN_FEATURE_ERRORS`, store
  errors via `BRAIN_FEATURE_STORE_ERROR_CODES`), else a logged error name and 503. No document text, SQL or paths.

## Integration wiring

- Startup: `api/start.ts` runs `bootstrapBrainBriefDatabase(kysely)` alone (a failure turns only the brief off), then
  `createBrainBrief({ repository, resolver })`, registers `feature.listener` and adds the scheduler to `jobs`;
  `api/feature-routes.ts` mounts the routes; `server.ts` starts jobs after owner services, stops them before shutdown.
- Kernel and MCP tools use the service (spec 562); no globals. `MATRIX_BRAIN_BRIEF_SUMMARY` (`1`/`true`/`on`) is read
  per request by the summary provider; off by default.

## Failure modes

- Timeouts: each write sets `lock_timeout 5s` and `statement_timeout 15s`; a scheduler pass is bounded by 120 s and an
  abort signal; a summary call by 60 s. No fetch or child process in this folder.
- Concurrent access: two builds of one brief both write; the upsert keeps the copy generated last and only that
  request answers `stored: true`. Writes take the brief's own scope lock, so they never block syncs or extraction.
- Erase during a build: before its upsert, a write checks that every cited document is live and every named source
  has a row; the `scope_erased` listener runs after the erase under the same lock, so a build writes first or not.
- Crash recovery: each write is one transaction (upsert plus prune); a crashed pass reruns next day or at start. Errors
  reach the mapper; runner failures are counted and logged by name; an unreadable stored body is logged and rebuilt.

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| lines per section / change groups / items per group / cites per line / line text | 50 / 20 / 10 / 4 / 400 chars | `sections.ts` |
| stored briefs per scope / bytes per brief | 60 / 256 KiB | `database.ts`, SQL CHECK |
| claims per conflict rule / label group / pairs compared / conflicts per claim / rule / clauses per statement | 2,000 / 200 / 20,000 / 3 / 500 / 8 | `conflicts.ts`, `text.ts` |
| spec documents / shipped pull requests dated after a Draft of their spec, scanned | 500 / 5,000 | `conflicts.ts` |
| stale items per kind / open commitments (pages of rows read) / sources per scope | 500 / 500 (10) / 100 | `stale.ts`, `reads.ts` |
| scopes per pass / pass time / summary input | 200 / 120 s / 200 lines and 40,000 chars | `service.ts`, `summary.ts` |

- Buffers: every list is capped by a scan before it is held; maps and sets live for one call; no files. The scheduler
  holds one timer, one controller and one pass; `stop()` clears and aborts them.
- Third-party data: none by default. With the flag on and a model wired, only the date and texts of lines citing
  only git documents go to it (`BRAIN_MODEL_PROVENANCES`, as in claim extraction; source lines of git sources only).

## Invariants

- **Source of truth**: owner Postgres core tables; `brain_brief_briefs` holds snapshots only, derived and rebuildable.
- **Lock/transaction scope**: writes and deletes take `brain-brief:<scopeId>` in one transaction; reads take no lock.
- **Acceptable orphan states**: a stored copy citing a later-deleted document lives until a pass or GET of its date
  deletes it (GET never returns it); one of an erased scope until the `scope_erased` listener runs. A build ending
  after the listener stores nothing naming the scope's documents or sources (an empty brief may still be stored).
- **Auth source of truth**: the request principal and the resolver's owner-scoped project lookup.
- **Deferred scope**: a summary model and its spend and usage records, organization scopes, delivering briefs to chat
  or mail, model-based conflict detection, conflict rules that read the graph, per-user brief settings.

## Integration test checkpoint

- `pnpm exec vitest run tests/gateway/brain-brief-*.test.ts`: 50 tests (PGlite, fake timers, fakes), 100% statement
  and branch coverage of `brain/brief/`; real routes and service over claims written through extraction runs.
- Manual (dev Docker, synced matrix-os): the 2026-10-01 brief lists 13 new git documents, 30 decisions, 7 risks and 50
  open commitments (truncated); 13 `draft_spec_shipped` conflicts; no stale items after a sync; `summary: true` is 409.

## Code review checklist

Every line has a cite; every scan has a limit; the brief never writes a core table; writes take only the brief lock;
no `catch {`; no model call or new dependency; generic errors only; the summary stays off without the flag.

## Delivery and evidence

- [ ] One PR under 3,000 additions, checks green, Invariants and the OS-view matrix (N/A) in the body.
- [ ] Site docs PR: brief, conflicts and stale routes.
