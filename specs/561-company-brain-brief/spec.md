# Company Brain brief, conflicts and stale data

**Status:** Implementation target (builds on specs 551-554) · **Owner:** `brain/brief/` · **Date:** 2026-10-02

## Outcome and scope

Each morning the owner opens one deterministic brief of a project: what changed, new decisions and risks, open
commitments and what needs attention, every line cited; conflicts and stale data also stand alone. In scope:
`brain/brief/`, four routes, a summary seam (flag off), tests; no stubs of Deferred scope. OS-view matrix: N/A (JSON).

## Brief model

- Table `brain_brief_briefs`, key `(owner_id, scope_id, brief_date, brief_window)`, plus `generated_at`, `body` (JSONB
  view without `stored`) and `byte_count`; CHECKs mirror the zod bounds; made under the `brain_brief_schema` lock.
- Windows are UTC on source time (`source_updated_at`; a first sync of old history does not fill today): `day` is
  `[date, +1 day)`, `week` the 7 days ending with it; a future date or one over 365 days back is `invalid_request`.
- A past window reads the brain at its end: each live document as its newest version dated before it (a snapshot if
  edited since, named by that version's title), its claims written before it was replaced and not on an older revision
  (outdated then), sources and receipts from before it. Refs and the document a source line cites are read as now.
- Sections (caps from `BRAIN_BRIEF_LIMITS`; `truncated` when one is hit):
  - changes: documents dated in the window by source (label, kind, created = revision 1 or first published in the
    window, revised = the rest), 10 newest per group, 20 groups, most active first.
  - decisions and risks: claims first seen in the window (of a revision 1, or written after their version was stored).
  - commitments: every open one, due date first, then newest: not stated done (a done word after a future, need,
    intent or condition word, before a deadline or as the verb `complete` is planned; at most 10 pages read) and not on
    a document whose `status` is done, completed, closed, merged, resolved, shipped or canceled. Due date and
    assignee: the claim's fields, else the document's `due` (a calendar day) and `assignee` refs.
  - attention: up to 10 conflicts (new ones first, the rest rotating daily so each shows), 20 stale items per kind.
- A line: one-line text (at most 400 characters), 1 to 4 cites (`BrainCiteView`), claim id and kind for a claim, due and
  assignee for commitments, severity for risks; a source line cites its newest live document (none: left out).
- Storage: GET returns the stored copy, rebuilt if built before its window ended and that has passed or it is an hour
  old; POST rebuilds. `stored: true`: the row holds it after the commit (at most 256 KiB, no later copy, under 60 newer
  ones, every named document and source live). Passes, `documents_changed` and GET delete copies naming deleted ones.
- Builds are read-only (10 s statement deadline), at most two at once (more: 503), scheduled ones included. A pass
  starts at the scope the last one stopped on, builds today's brief unless fresh, rebuilds day copies of the last 7
  days built before their day ended (a failed one is retried), skips gone projects and stops on abort.

## Conflicts and stale data

Computed on demand, newest side first, each with both sides (cite, claim id, statement, verbatim quote up to 300 chars),
a stable id (`cfl_` + 32 hex of sha256 of the rule and sorted side keys) and `detectedAt`, the newer side's date.

- `label_disagreement`: decision or invariant claims of two documents, same normalized label (not `Deferred scope`),
  with a clause of each on the same content words (0.8 overlap) and opposite negation (`stored`, `never stored`) or
  other numbers (`8 runs`, `16 runs`); same label alone is noise (about 22,000 pairs here). Cross-source pairs go first.
- `draft_spec_shipped`: a spec part 1 whose first status line in its first 40 lines reads Draft, and a merged pull
  request (`git_pr`, or `github_pr` with status `merged`) dated after the spec that references it and changes a path
  outside `specs/`. One per spec, with the first such pull request (each spec gets its share of the scan); 13 here.
- `commitment_reversed`: two commitments with the same label (or none) on the same thing (0.5 word overlap without state
  words), one done and one deferred (statement words, else the status ref); the newer one decides the summary.
- Caps (see Resource management) keep a rule near 100 ms; pairs are compared the first rows of every group first.
- Stale data: `claim_outdated`: a live document's claim of an older revision (`since`: when it was replaced);
  `source_sync_old`: an active source with no succeeded or partial receipt for 7 days (from creation if it never
  synced); `source_failing`: its newest receipt failed (text names the code); `commitment_overdue`: an open commitment
  due before today (in a brief, its date). Newest `since` first, then kind, id; source items: `cite: null`, `sourceId`.

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

- Input: project ref pattern, bodyLimit, strict zod (also in the service), real calendar dates, bounded lists, strict
  cursor regex, bound SQL parameters; no credentials. Errors: `{ error: { code, message } }`, fixed messages (API,
  feature and feature store codes), else a logged name and 503; never document text, SQL or paths.

## Integration wiring

- Startup: `api/start.ts` runs `bootstrapBrainBriefDatabase(kysely)` alone (a failure turns only the brief off), then
  `createBrainBrief({ repository, resolver })`, registers `feature.listener` and adds the scheduler to `jobs`;
  `api/feature-routes.ts` mounts the routes; `server.ts` starts jobs after owner services, stops them before shutdown.
- Kernel and MCP tools use the service (spec 562), no globals; `MATRIX_BRAIN_BRIEF_SUMMARY` is read per request.

## Failure modes

- Timeouts: writes `lock_timeout 5s`, `statement_timeout 15s`; a pass 120 s and an abort signal; a summary call 60 s.
- Concurrent access: the upsert keeps the copy generated last under the brief's own scope lock (syncs never wait); a
  write checks cited documents are live and named sources exist first, and `scope_erased` runs under that lock.
- Crash recovery: one transaction per write; a crashed pass reruns next day or at start; an unreadable copy is rebuilt.

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| lines per section / change groups / items per group / cites per line / line text | 50 / 20 / 10 / 4 / 400 chars | `sections.ts` |
| stored briefs per scope / bytes per brief | 60 / 256 KiB | `database.ts`, SQL CHECK |
| claims per conflict rule / label group / pairs compared / conflicts per claim / rule / clauses per statement | 2,000 / 200 / 20,000 / 3 / 500 / 8 | `conflicts.ts`, `text.ts` |
| spec documents / shipped pull requests dated after a Draft of their spec, shared out per spec | 500 / 5,000 | `conflicts.ts` |
| stale items per kind / open commitments (pages of rows read) / sources per scope | 500 / 500 (10) / 100 | `stale.ts`, `reads.ts` |
| scopes per pass / pass time / summary input | 200 / 120 s / 200 lines and 40,000 chars | `service.ts`, `summary.ts` |

- Buffers: capped scans, per-call maps and sets, no files; the scheduler holds a timer, controller and pass, the runner
  a resume index. Third-party data: only with the flag and a model, the lines citing only git documents or sources.

## Invariants

- **Source of truth**: owner Postgres core tables; `brain_brief_briefs` holds snapshots only, derived and rebuildable.
- **Lock/transaction scope**: writes and deletes take `brain-brief:<scopeId>` in one transaction; reads take no lock.
- **Acceptable orphan states**: a copy citing a later-deleted document until a pass or GET of its date (never served);
  an erased scope's until `scope_erased` runs, after which a build stores nothing naming its documents or sources.
- **Auth source of truth**: the request principal and the resolver's owner-scoped project lookup.
- **Deferred scope**: a summary model and its spend and usage records, organization scopes, delivery to chat or mail,
  model-based conflict detection, conflict rules that read the graph, per-user brief settings.

## Evidence and delivery

- `pnpm exec vitest run tests/gateway/brain-brief-*.test.ts`: 50 tests (PGlite, fake timers, fakes), 100% statement
  and branch coverage of `brain/brief/`; real routes and service over claims written through extraction runs.
- Manual (dev Docker, synced matrix-os): the 2026-10-01 brief lists 13 new git documents, 30 decisions, 7 risks and 50
  open commitments (truncated); 13 `draft_spec_shipped` conflicts; no stale items after a sync; `summary: true` is 409.
- Review: lines cited, scans capped, no core table write, brief lock only; no `catch {`, model call or new dependency.
- [ ] One PR under 3,000 additions, checks green, Invariants and OS-view matrix (N/A) in the body; a site docs PR.
