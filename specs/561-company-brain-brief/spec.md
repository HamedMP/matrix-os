# Company Brain brief, conflicts and stale data

**Status:** Implementation target (brief layer of the brain stack; builds on specs 551, 552, 553, 554)  
**Owner:** gateway `brain` domain (`brain/brief/`)  
**Date:** 2026-10-02

## Outcome

Each morning the owner can open one deterministic brief of a project: what changed (new and revised documents by
source), new decisions and risks, open commitments with due dates and assignees, and what needs attention (open
conflicts, overdue commitments, failing or quiet sources, claims whose document changed). Every line cites at least
one document. The same data is also listed on its own: conflicts between sources and stale data. A summary paragraph
written by a model is possible later, behind a flag that is off.

## Scope of this increment

In scope: `brain/brief/` (table, service, rules, runner, scheduler, routes), four routes, the summary seam and flag,
tests. Out of scope (no stubs): see Deferred. OS-view surface matrix: N/A (a JSON API; spec 563 shows it).

## Brief model

- Table `brain_brief_briefs`, primary key `(owner_id, scope_id, brief_date, brief_window)`: `brief_date`
  (`YYYY-MM-DD`), `brief_window` (`day` or `week`), `generated_at`, `body` (JSONB view without `stored`),
  `byte_count`. CHECKs mirror the zod bounds. Created by `bootstrapBrainBriefDatabase` under the
  `brain_brief_schema` lock. Scope-level rows: no document foreign key; `scope_erased` deletes them.
- Windows are UTC: `day` is `[date, date + 1 day)`, `week` the 7 days ending with the date. A date in the future or
  more than 365 days back is `invalid_request`.
- Windows read source time (`source_updated_at`), not store time, so a first sync that imports years of history does
  not fill today's brief.
- Sections (caps from `BRAIN_BRIEF_LIMITS`; `truncated` when one is hit):
  - changes: live documents dated in the window, grouped by source (label, kind, created = revision 1 or first
    published in the window, revised = the rest), 10 newest items per group, 20 groups, most active first.
  - decisions and risks: current claims (read from the live revision) first seen in the window: the document is
    dated in the window and is at revision 1, or the claim was written after the document's last revision. So a
    revised spec lists only its new claims.
  - commitments: every open commitment, due date first, then newest. Open means current, not stated done, and not on
    a document whose `status` ref is done, completed, closed, merged, resolved, shipped or canceled. Planned wording
    is not stated done: a done word after a future, need, intent or condition word of its clause (`will be
    shipped`, `ensure it is completed`, `once merged`), before a deadline (`completed by Friday`) or an imperative
    `Complete ...`. Closed documents are filtered in SQL before the limit; commitments stated done are skipped by
    reading on in pages of the limit, at most 10 pages, so finished work does not hide open work. The due date and
    assignee come from the claim's fields, else from the document's `due` ref (only a `YYYY-MM-DD` of a real
    calendar day; `2025-13-01` or `2026-02-30` count as no date) and `assignee` ref (a person key); trackers such
    as Linear put them in refs, and rules/v1 never sets the fields. A past window (ended before now) sees
    commitments and conflicts only from documents dated before its end.
  - attention: up to 10 conflicts (those detected in the window first, then the rest in a daily rotation, so every
    open conflict shows in some brief), then up to 20 stale items per kind, 50 lines in all.
- A line: plain one-line text (at most 400 characters), 1 to 4 cites (`BrainCiteView`, label rule of
  `contracts/common.ts`), claim id and kind when it comes from a claim, due and assignee for commitments, severity
  for risks. A source line cites the source's newest live document; a source with none is left out of the brief.
- Storage: GET returns the stored copy. A copy built before its window ended is rebuilt on GET once the window has
  ended or the copy is an hour old. POST always rebuilds. 60 copies per scope are kept, newest date first.
  `stored: true` means the row holds this brief after the write commits. A brief is returned with `stored: false`
  when it is over 256 KiB, when a copy generated later is stored, when 60 newer copies are stored (the prune would
  drop it at once, so such old dates are rebuilt on every GET), or when a document or source it names is gone.
  GET never returns a stored copy that cites a document or names a source deleted since: it deletes the copy and
  rebuilds the date. Every scheduled pass and every `documents_changed` event (the bus routes it to `brief`)
  deletes all stored copies of the scope that cite a tombstoned or erased document. Builds and reads run read-only
  with a 10 s statement deadline; at most two builds run at once (more: 503), scheduled ones included (a scope the
  cap refuses counts as failed and the next pass retries it). The scheduled pass skips a project
  scope whose project no longer resolves.

## Conflicts

Computed on demand, newest side first, each with both sides (cite, claim id, statement, verbatim quote of at most 300
characters) and a stable id (`cfl_` + 32 hex of sha256 of the rule and the sorted side keys).

- `label_disagreement`: two current decision or invariant claims of different documents with the same normalized
  label (not `Deferred scope`) whose statements contradict: one clause of each has the same content words with
  opposite negation (`stored` and `never stored`, `enabled` and `disabled`), or the same words with other numbers
  (`at most 8 runs` and `at most 16 runs`), at 0.8 word overlap. Same label alone is not enough: on this repository
  it gives about 22,000 pairs of per-change invariants and no real conflict. Cross-source pairs go first.
- `draft_spec_shipped`: a spec part 1 whose first status line in its first 40 lines reads Draft, and a merged pull
  request (`git_pr`, or `github_pr` with status `merged`) dated after the spec that references the spec and changes a
  path outside `specs/`. One conflict per spec, with the first such pull request. 13 specs on this repository.
- `commitment_reversed`: two commitments with the same label (or both none) about the same thing (0.5 word overlap
  without state words) where one is done and the other deferred (statement words, else the document's status ref).
  The newer one decides the summary: done after deferred, or deferred again after done.
- Each claim is in at most 3 conflicts; at most 500 conflicts per rule. At most 20,000 pairs are compared per rule,
  the first rows of every group first, and only the first 8 clauses of a statement, so a rule stays near 100 ms.
- `detectedAt` is the newer side's date, so a conflict keeps its id and time while both sides are live.

## Stale data

- `claim_outdated`: a claim of a live document read from an older revision; `since` is when that revision was
  replaced (its revision snapshot), else the document's update time.
- `source_sync_old`: an active source with no succeeded or partial receipt for 7 days (since it was created when it
  never synced); `since` is the moment it crossed the 7 days.
- `source_failing`: an active source whose newest receipt failed; the text names the stable error code.
- `commitment_overdue`: an open commitment due before today (or before the brief's date in a brief); the due date
  is the claim's, else the document's `due` ref.
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

Paging is an offset cursor (base64url JSON `{v, k, o}`, at most 512 characters); `k` fingerprints the endpoint and
its filters, so a cursor from another query is `invalid_request`. `summary: true` without the flag and a model is
409 `summary_not_configured`.

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| The four routes | `authMiddleware`, `requireRequestPrincipal` | project owned by the principal (resolver); scope `personal:project:<id>` | fixed codes |
| Runner and scheduler | server code | scopes with a live source of the gateway owner | counted, logged by name |
| `scope_erased` listener | server code | the erased scope key | rejects on database errors |

- Input validation: project ref pattern, bodyLimit, strict zod queries and bodies (also in the service for direct
  callers), real calendar dates, bounded lists, strict cursor regex, bound SQL parameters only.
- Error policy: `{ error: { code, message } }` with fixed messages from `BRAIN_API_ERRORS` and
  `BRAIN_FEATURE_ERRORS`; store errors map through `BRAIN_FEATURE_STORE_ERROR_CODES`; anything else is a logged
  error name and 503. No document text, SQL, paths or provider text in logs or answers.
- Credentials: none in this increment. A later summary model gets its credential through the provider the wiring
  passes; the brief never reads, logs or stores one.

## Integration wiring

- Startup: `api/start.ts` runs `bootstrapBrainBriefDatabase(kysely)` on its own (a failure leaves only the brief
  off), then `createBrainBrief({ repository, resolver })`, registers `feature.listener` and adds the scheduler to
  `jobs`. `api/feature-routes.ts` mounts the routes; `server.ts` starts jobs after owner services and stops them
  before the owner Kysely is destroyed.
- Cross-package: the kernel and MCP tools reach the brief through the service (spec 562); no globals.
- Config: `MATRIX_BRAIN_BRIEF_SUMMARY` (`1`, `true` or `on`; default off), read per request by
  `createBrainBriefSummaryProvider`; `api/start.ts` starts the brief feature and its daily job.

## Failure modes

- Timeouts: each write sets `lock_timeout 5s` and `statement_timeout 15s`; a scheduler pass is bounded by 120 s and an
  abort signal; a summary call by 60 s. No fetch or child process in this folder.
- Concurrent access: two requests that build one brief both write; the upsert keeps the copy generated last and
  only that request answers `stored: true`. Writes use the brief's own scope lock, so they never block syncs or
  extraction.
- Erase during a build: before its upsert, a write counts the documents its lines cite and the sources its change
  groups name (tombstones keep their rows; only `eraseScope` deletes them). If any is gone it stores nothing. The
  `scope_erased` listener runs after the erase commits and takes the same lock, so a build either writes before the
  listener (which then deletes it) or sees the erase and stores nothing.
- Crash recovery: every write is one transaction (upsert plus prune), so a crash leaves the old copy. A crashed
  scheduler pass is simply run again the next day or at start.
- Error propagation: route errors reach the mapper; runner failures are counted per scope and logged by name; a
  stored body that no longer reads as a brief is logged and rebuilt. No catch-and-ignore.

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| lines per section / change groups / items per group / cites per line / line text | 50 / 20 / 10 / 4 / 400 chars | `sections.ts` |
| stored briefs per scope / bytes per brief | 60 / 256 KiB | `database.ts`, SQL CHECK |
| claims scanned per conflict rule / per label group / pairs compared / conflicts per claim / per rule | 2,000 / 200 / 20,000 / 3 / 500 | `conflicts.ts` |
| clauses compared per statement | 8 | `text.ts` |
| spec documents / shipped pull requests scanned | 500 / 5,000 | `conflicts.ts` |
| stale items per kind / open commitments (pages of rows read) / sources per scope | 500 / 500 (10) / 100 | `stale.ts`, `reads.ts` |
| scopes per pass / pass time / summary input | 200 / 120 s / 200 lines and 40,000 chars | `service.ts`, `summary.ts` |

- Buffers: every list is capped by a scan limit before it is held in memory; maps and sets live for one call.
- Files: none written. Stored briefs are rows, pruned by count.
- Memory: the scheduler holds one timer, one controller and one pass; `stop()` clears and aborts them.
- Third-party data: none by default. With the flag on and a model wired, only the date and the texts of lines whose
  every cite is a git document (`BRAIN_MODEL_PROVENANCES`: `git_pr`, `git_commit`, `git_spec`) go to it, the same
  rule as model claim extraction. Lines citing chats, notes, files, calendar, Slack, Linear or GitHub documents never
  do; a source line goes only when it cites a git document of a git source.

## Invariants

- **Source of truth**: owner Postgres core tables; `brain_brief_briefs` holds snapshots only, derived and rebuildable.
- **Lock/transaction scope**: brief writes take `brain-brief:<scopeId>` in one transaction (upsert and prune, or
  delete); reads take no lock, except a GET that deletes a stored copy citing a deleted document.
- **Acceptable orphan states**: a stored brief keeps a document deleted after it was built until the next scheduled
  pass or GET of its date deletes it (GET never returns it); a stored brief of an erased scope lives until the
  `scope_erased` listener runs. A build that finishes after the listener stores nothing that names the scope's
  documents or sources; a brief with no lines and no change groups may still be stored, and it holds no text of the
  scope.
- **Auth source of truth**: the request principal and the resolver's owner-scoped project lookup.
- **Deferred scope**: a summary model and spend records, organization scopes, delivering briefs to chat or mail,
  model-based conflict detection, per-user brief settings.

## Integration test checkpoint

- `pnpm exec vitest run tests/gateway/brain-brief-*.test.ts`: 48 tests over PGlite, fake timers and fakes; coverage of
  `brain/brief/` is 100% statements and branches.
- End to end in tests: a real service behind the routes builds, stores and serves a brief; conflicts and stale data
  are built from real claims written through extraction runs.
- Manual (dev Docker stack, after wiring, on the synced matrix-os project): `GET .../brief?date=2026-10-01` lists 13
  new documents of the git source, 30 decisions and 7 risks of that day, 50 open commitments (truncated) and the
  Draft-spec conflicts under attention; `GET .../conflicts` lists 13 `draft_spec_shipped` items (for example
  `specs/094-electron-macos-shell` with `#1608`); `GET .../stale` is empty right after a sync;
  `POST .../brief` with `{"summary":true}` is 409 `summary_not_configured`.

## Code review checklist

Every line has a cite; every scan has a limit; the brief never writes a core table; writes take only the brief lock;
no `catch {`; no model call or new dependency; generic errors only; the summary stays off without the flag.

## Delivery and evidence

- [ ] One PR under 3,000 additions, checks green, Invariants and the OS-view matrix (N/A) in the body.
- [ ] Site docs PR: brief, conflicts and stale routes.

## Deferred

Everything under Deferred scope above, plus a shared `brain/cite.ts`, record of summary usage, and conflict rules
that read the graph (same entity across names).
