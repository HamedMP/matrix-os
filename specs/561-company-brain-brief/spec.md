# Company Brain brief, conflicts and stale data

**Status:** Implementation target (builds on specs 551-554) · **Owner:** `brain/brief/` · **Date:** 2026-10-02

## Outcome and scope

Each morning the owner opens one deterministic brief of a project: what changed, new decisions and risks, open
commitments and what needs attention, every line cited; conflicts and stale data also stand alone. In scope:
`brain/brief/`, four routes, a summary seam (flag off), tests; no stubs of Deferred scope. OS-view matrix: N/A (JSON).

## Brief model

- Table `brain_brief_briefs`, key `(owner_id, scope_id, brief_date, brief_window)`, plus `generated_at`, `body` (the
  view without `stored`) and `byte_count`; CHECKs mirror the zod bounds; made under the `brain_brief_schema` lock.
- Windows are UTC on source time (`source_updated_at`, so a first sync of old history does not fill today): `day` is
  `[date, +1 day)`, `week` the 7 days ending with it; a future date or one over 365 days back is `invalid_request`.
- A past window reads the brain at its end: live documents as their newest version dated before it, claims written
  before that version was replaced, on no older revision and quoted in it, older sources and receipts (refs as now).
  Claims keep no history: each rebuild keeps the old copy's decision or risk lines (and the revision they cite) whose
  claim was deleted since, unless their document had a newer revision at the window's end than the line cites.
- Sections (`BRAIN_BRIEF_LIMITS` caps, `truncated` when hit): changes (documents dated in the window; created = revision
  1 or first published in it, else revised); decisions and risks (claims first seen in the window: of a revision 1 or
  written after their version was stored); commitments (open, due first: not stated done (`text.ts`) nor on a
  `CLOSED_STATUSES` document; due and assignee from the claim, else the document's refs); attention (10 conflicts, new
  first, the rest rotating daily; 20 stale items per kind; a source line cites its newest live document).
- GET serves the stored copy, rebuilt if built before its window ended and that has passed or it is an hour old; POST
  rebuilds. `stored: true`: the row holds it after the commit (no later copy, under 60 newer ones, cites live).
- Builds are read-only (10 s deadline), two at most at once (more: 503), scheduled ones too. A pass takes scopes tried
  least lately first (then stalest brief), builds today's brief unless fresh, rebuilds day copies of the last 7 days
  built before their day ended (so failed ones retry) and skips gone projects.

## Conflicts and stale data

On demand, newest first: both sides (cite, claim id, statement, quote up to 300 chars), a `cfl_` id hashed from the rule
and sorted sides, `detectedAt` (the newer side's date). `label_disagreement`: decision or invariant claims of two
documents, same normalized label, a clause each on the same words with opposite negation or other numbers.
`draft_spec_shipped`: a Draft spec part 1 and the first merged pull request after it that references it and changes a
path outside `specs/` (each spec its share of the scan). `commitment_reversed`: two commitments on the same thing, one
done, one deferred. Stale: `claim_outdated`, `source_sync_old` (no success for 7 days), `source_failing`, and
`commitment_overdue` (due before today or the brief's date); newest `since` first; source items cite nothing.

## Routes

| Method, path | Input | Success | Errors |
| --- | --- | --- | --- |
| GET `/projects/:projectId/brief` | `date` (`YYYY-MM-DD`), `window` (`day`, `week`) | 200 `BrainBriefView` | 400 401 404 503 |
| POST `/projects/:projectId/brief` | bodyLimit 1 KiB; empty or strict `{ date?, window?, summary? }` | 200 `BrainBriefView` | 400 401 404 409 413 503 |
| GET `/projects/:projectId/conflicts` | `rules` (comma list), `limit` 1..50 (20), `cursor` | 200 `BrainConflictsView` | 400 401 404 503 |
| GET `/projects/:projectId/stale` | `kinds` (comma list), `limit` 1..50 (20), `cursor` | 200 `BrainStaleView` | 400 401 404 503 |

## Security architecture

Auth matrix: the four routes take `authMiddleware` and `requireRequestPrincipal`, then the resolver's lookup of a
project the principal owns (scope `personal:project:<id>`); the runner, scheduler and `scope_erased` listener are server
code over the gateway owner's scopes with a live source, or the erased scope. Spec 553 rules (principal first, 503 with
no service, ref pattern, `exactQuery`, strict zod, `private, no-store`, one error mapper), bodyLimit, calendar dates,
bounded lists, a 512-char offset cursor bound to its query, bound SQL. Errors: `{ error: { code, message } }`, fixed
messages (409: `summary: true` with no model), else a logged name and 503; never document text, SQL or paths.

## Integration wiring, failure modes and resource management

`api/start.ts` runs `bootstrapBrainBriefDatabase` alone (failing turns off only the brief), registers the listener and
the scheduler (`jobs`); `api/feature-routes.ts` mounts the routes; kernel and MCP tools use the service. Timeouts:
writes 5 s (lock) and 15 s (statements), a pass 120 s (plus an abort signal), a summary call 60 s; unreadable copies are
rebuilt. Caps: 50 lines a section (400 chars, 1 to 4 cites), 20 change groups of 10, 60 stored briefs of 256 KiB per
scope, 2,000 claims per conflict rule, 20,000 pairs, 5,000 shipped pull requests, 500 stale items per kind and open
commitments (10 pages), 100 sources, 200 scopes a pass, summary input 200 lines, 40,000 chars.

## Invariants

- **Source of truth**: owner Postgres core tables; `brain_brief_briefs` holds snapshots only, derived and rebuildable.
- **Lock/transaction scope**: writes and deletes take `brain-brief:<scopeId>` in one transaction; reads take no lock.
- **Acceptable orphan states**: a copy naming a deleted document or erased scope until a pass, GET or listener drops it.
- **Auth source of truth**: the request principal and the resolver's owner-scoped project lookup.
- **Deferred scope**: a summary model and spend, organization scopes, chat or mail delivery, model or graph rules.

## Evidence and delivery

- `pnpm exec vitest run tests/gateway/brain-brief-*.test.ts` (PGlite, fake timers): 100% coverage of `brain/brief/`; by
  hand (dev Docker), 2026-10-01: 13 git documents, 30 decisions, 7 risks, 50 commitments, 13 shipped drafts.
- [ ] One PR under 3,000 additions, checks green, Invariants and OS-view matrix (N/A) in the body; a site docs PR.
