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
  Claims keep no history: a rebuild keeps the replaced copy's decision or risk lines whose claim was deleted since,
  unless their document had a newer revision at the window's end than the line cites.
- Sections (`BRAIN_BRIEF_LIMITS` caps; `truncated` when one is hit): changes (documents dated in the window by source,
  created = revision 1 or first published in the window, else revised); decisions and risks (claims first seen in the
  window: of a revision 1 or written after their version was stored); commitments (open ones, due first: not stated
  done (`text.ts`) nor on a document of a `CLOSED_STATUSES` status; due and assignee from the claim, else the
  document's refs); attention (10 conflicts, new ones first, the rest rotating daily; 20 stale items per kind).
- A line: text (at most 400 chars), 1 to 4 cites and claim fields; a source line cites its newest live document.
- GET returns the stored copy, rebuilt if built before its window ended and that has passed or it is an hour old; POST
  rebuilds. `stored: true`: the row holds it after the commit (at most 256 KiB, no later copy, under 60 newer ones,
  named documents and sources live). Passes, `documents_changed` and GET delete copies naming deleted documents.
- Builds are read-only (10 s statement deadline), at most two at once (more: 503), scheduled ones included. A pass
  takes scopes stalest brief first, builds today's brief unless fresh, rebuilds day copies of the last 7 days built
  before their day ended (a failed one is retried), skips gone projects and stops on abort.

## Conflicts and stale data

On demand, newest side first, both sides (cite, claim id, statement, quote up to 300 chars), a `cfl_` id hashed from
the rule and sorted sides, and `detectedAt` (the newer side's date). `label_disagreement`: decision or invariant claims
of two documents, same normalized label, a clause each on the same words with opposite negation or other numbers.
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

Spec 553 rules (principal first, 503 with no service, ref pattern, `exactQuery`, strict zod, `private, no-store`, one
error mapper); a 512-char offset cursor bound to its query; `summary: true` with no model is 409.

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| The four routes | `authMiddleware`, `requireRequestPrincipal` | project owned by the principal (resolver); scope `personal:project:<id>` | fixed codes |
| Runner, scheduler, `scope_erased` listener | server code | the gateway owner's scopes with a live source; the erased scope | logged by name |

Input: project ref pattern, bodyLimit, strict zod, calendar dates, bounded lists, cursor regex, bound SQL parameters.
Errors: `{ error: { code, message } }`, fixed messages, else a logged name and 503; never document text, SQL or paths.

## Integration wiring and failure modes

`api/start.ts` runs `bootstrapBrainBriefDatabase` alone (a failure turns only the brief off), registers the listener
and adds the scheduler to `jobs`; `api/feature-routes.ts` mounts the routes; kernel and MCP tools use the service.
Writes: 5 s lock and 15 s statement timeouts under the brief's own scope lock (syncs never wait); the upsert keeps
the copy generated last; a pass has 120 s and an abort signal, a summary call 60 s; an unreadable copy is rebuilt.

## Resource management

Caps: lines per section 50, change groups 20 of 10 items, 4 cites a line, 60 stored briefs of 256 KiB per scope,
2,000 claims per conflict rule, 20,000 pairs, 5,000 shipped pull requests, 500 stale items per kind and open
commitments (10 pages read), 100 sources, 200 scopes per pass, summary input 200 lines and 40,000 chars.

## Invariants

- **Source of truth**: owner Postgres core tables; `brain_brief_briefs` holds snapshots only, derived and rebuildable.
- **Lock/transaction scope**: writes and deletes take `brain-brief:<scopeId>` in one transaction; reads take no lock.
- **Acceptable orphan states**: a copy naming a deleted document or erased scope until a pass, GET or listener drops it.
- **Auth source of truth**: the request principal and the resolver's owner-scoped project lookup.
- **Deferred scope**: a summary model and spend, organization scopes, chat or mail delivery, model or graph rules.

## Evidence and delivery

- `pnpm exec vitest run tests/gateway/brain-brief-*.test.ts` (PGlite, fake timers): 100% coverage of `brain/brief/`;
  by hand (dev Docker), 2026-10-01: 13 git documents, 30 decisions, 7 risks, 50 commitments, 13 shipped drafts.
- [ ] One PR under 3,000 additions, checks green, Invariants and OS-view matrix (N/A) in the body; a site docs PR.
