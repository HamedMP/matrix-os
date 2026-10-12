# Company Brain connector sources

**Status:** Implementation target (sources layer of the brain stack; builds on specs 551 to 554)  
**Owner:** gateway `brain` domain (`brain/sources/connectors/`)  
**Date:** 2026-10-02

## Outcome

A project's brain holds Linear issues, comments and project updates, Google Docs from chosen Drive folders, Google
Calendar events and the Slack threads the Company Brain captured: each kind a source with a stored config, bounded runs
of one shared runner (`runBrainSourceSync`), receipts, stable error codes and the refs search, graph and brief read.

## Scope of this increment

In scope: `brain/sources/connectors/` (kind handlers, adapters, snapshot engine, runner, `brain_connector_sources`),
tests and this spec; everything under Deferred is out, with no stubs (kinds plug into the `/sources` service through
`BrainSourcesServiceDeps.handlers` and `runner`). No routes; OS-view surface matrix: N/A (no route or UI).

## Model

- Document ids: `sha256(JSON.stringify([version, externalRef, ...tail]))`, tails `["issue" | "comment" |
  "project_update", id]`, `["file", fileId]`, `["event", calendarId, eventId]`, `["thread", companySourceId]`, never a
  content hash. External refs, fixed at connect time: `<kind>:` + a 40-hex hash of the account label and sorted ids.
- Refs: Linear handle, issue, parent, author, assignee (`linear:<userId>`), labels (20), status, due; Drive author
  (`email:`); Calendar starts_at (UTC), author, attendee (50, no rooms), status; Slack channel (`C`/`G`, allowed ones).
- Calendar descriptions and locations only with `includeEventBodies`; without it a private or confidential event is
  titled "Private event" (`private_body_omitted`). Bodies are cut to 64 KiB (`body_truncated`); titles are one line of
  at most 300 characters; permalinks are canonical https or empty.

## Sync

- Runner: strict options, live active source of the adapter's kind, capped in-process guard, open receipt, pages until
  caught up, `pagesPerRun` or the run budget (checked between pages), close receipt. Each page is one `applySyncBatch`
  with `expectedCursor`; foreign provenances, too many upserts or refs, or a bad skip count are `document_invalid`
  before any write. A page that wrote, deleted, replaced refs or moved only a date emits `documents_changed`.
- Linear (`lin1:`): issues, comments and updates, each a pass over `updatedAt >= since` with GraphQL paging; a
  watermark moves to the newest `updatedAt` seen when its pass ends; the first pass reads 365 days back
  (`history_window_limited`). Archived or trashed items are deletions; a config change starts over.
- Snapshot engine (Drive `gd1:`, Calendar `gc1:`, Slack `sb1:`): a run's first page lists remote items, reads back
  stored ones and plans changed stamps (all, resumably, during a re-render), deletions of stored items missing from a
  complete listing (Drive, Slack; Calendar while re-rendering) or cancelled, and a 2,000-event calendar history. Work
  runs oldest first after `r` (the last item handled), so skipped items wait behind newer ones.
- A page that writes takes a new cursor token, so an overlapping run fails its compare-and-set (`cursor_conflict`).
  The store applies a page's deletions first and, at the document cap, reclaims the source's oldest tombstones.

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| kind handlers, `runBrainSourceSync` | server code | caller-resolved owner id and `BrainScopeKey`; `(owner_id, scope_id)` in every statement | `BrainFeatureError` codes, result codes |
| integration caller (Linear, Drive, Calendar) | the owner's connected account in the integration layer | one owner, read actions only | outcome values, never provider text |
| Slack capture reader | owner authority in the Company Brain service, checked per read | the configured company scope | `forbidden`, `not_found`, `unavailable` |

- Input validation: strict zod configs (team keys `[A-Z][A-Z0-9]{0,9}`, Drive ids `[A-Za-z0-9_-]`, calendar ids one
  URL path segment and never `.` or `..`, company scope uuid, `C`/`G` channel ids, unique bounded lists, no unknown
  keys, 8 KiB stored JSON); provider data through bounded zod schemas, then the store schemas.
- Errors and credentials: clients see only `source_*` or sync codes; logs carry event names, codes and error names,
  never provider text, tokens or content; configs never hold tokens (the integration layer keeps them).

## Integration wiring

- Startup: `bootstrapBrainConnectorDatabase(db)`; handlers built with `{ kysely, integrations, isConnected, accounts }`
  go with `runBrainSourceSync` to the sources service. Without `isConnected` a kind is `not_configured` and its runs
  fail `provider_unavailable`; with `accounts` a run uses only its pinned or the owner's single account. Slack gets
  `capture` after PR #2078; no kernel, MCP or environment change. Read actions (`registry-brain.ts`): `brain_issues`,
  `brain_comments`, `brain_project_updates`, `brain_list_folder`, `brain_export_text`, `brain_list_events`.

## Failure modes

- Timeouts: provider calls and capture reads race `providerTimeoutMs` with the page signal, even if ignored
  (`provider_timeout`); a page aborts only with the caller (`run_budget_exhausted`) or at 120 s (`provider_timeout`).
- Provider outcomes: `not_connected`, `auth_failed`, `rate_limited` (hint 1 s to 1 h), `remote_not_found`,
  `config_invalid`, `provider_unavailable`, `provider_output_invalid`. Drive exports not found, refused, invalid or
  unavailable are skipped (`too_large_skipped`) and retried next run. Slack: an unreadable thread makes the read
  incomplete; a lost company scope sweeps every copy (bounded reads), then fails `auth_failed`/`remote_not_found`.
- Concurrency: one run per source per process; across processes the cursor compare-and-set fails the loser
  (`cursor_conflict`, or `source_inactive`). Config saves serialize under the feature lock and refuse other kinds.
- Recovery and errors: pages are atomic with their cursor; the next run closes a crashed receipt as interrupted and
  resumes from cursor and store; a thrown adapter error is `internal_error`, a failed receipt close `receipt: null`.

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| pages per run, upserts and refs per page, run budget | 20 / 100 / 5,000 / 20 s (ceilings 200 / 200 / 10,000 / 120 s); one page at most 120 s | `runner.ts` |
| provider call timeout; Linear page size, first window | 10 s (handler option, 1 to 30 s); 100 nodes (fewer when refs per page / 26 is lower), 365 days | `handlers.ts`, `linear.ts` |
| Drive files, folders, depth, list calls, exports per page | 2,000 / 30 / 2 / 40 / 10 | `google-drive.ts` |
| Calendar events per listing and kept per source, page size, attendees, list calls | 2,000 / 250 / 50 / 40 | `google-calendar.ts` |
| Slack threads per read; stored documents read back per plan | 1,000; 5,000 | `slack-bridge.ts`, `snapshot.ts` |
| config lists; stored config; in-process runs, notices and rejected ids per result | 20 teams, 20 folders, 10 calendars, 50 channels; 8 KiB; 16, 16, 100 | `handlers.ts`, SQL CHECK, `runner.ts` |

Every Map and Set is bounded by these caps and lives for one call or run. Third-party data flow: read requests only.

## Invariants

- **Source of truth**: provider data; core copies only via `applySyncBatch`; configs in `brain_connector_sources`.
- **Lock/transaction scope**: each page is one store transaction under the core scope lock; config writes take
  `brain-connector:<scopeId>`; provider calls run outside transactions.
- **Acceptable orphan states**: documents of removed Linear teams stay until the source goes; events past the window
  stay until a calendar config change (2,000 at most); earlier calendar bodies stay in revision history until
  `deleteSource`, so turning `includeEventBodies` off removes and reconnects the source; crashed receipts stay running.
- **Auth source of truth**: the caller-resolved project scope, the owner's integration accounts, and live Company
  Brain owner authority for Slack. **Deferred scope**: listed below.

## Code review checklist

Provider reads only via the integration caller (read actions, byte-capped, cancellable, timed out); caps on every page,
upsert and ref list; only codes and error names leave; outages are not `not_connected`; no `catch {` or new dependency.

## Integration test checkpoint, delivery and evidence

`pnpm exec vitest run tests/gateway/brain-source-connectors-*.test.ts` (PGlite and fakes, no network). Manual (dev
Docker stack): connect Linear for a project, sync until `nextAction` is empty; `GET .../why` and search cite `ENG-N`.

- [ ] One PR (3,000 added lines), checks green, Invariants and the OS-view matrix (N/A) in the body.
- [ ] Site docs PR (`FinnaAI/matrix-os-site`): connector sources and their privacy rules.

## Deferred

Open: option lookups, the Slack capture reader over `CompanyBrainService.export`, scheduled syncs, Drive files other
than Google Docs, Linear deletions without an archived record, history past 365 days. Later in the stack: the `/sources`
service and routes with the remove-and-reconnect rule (565), the integration caller, registry actions, Sources screen.
