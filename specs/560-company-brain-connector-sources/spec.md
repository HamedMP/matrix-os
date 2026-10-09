# Company Brain connector sources

**Status:** Implementation target (sources layer of the brain stack; builds on specs 551 to 554)  
**Owner:** gateway `brain` domain (`brain/sources/connectors/`)  
**Date:** 2026-10-02

## Outcome

A project's brain can hold more than its git history: Linear issues, comments and project updates, Google Docs from
chosen Drive folders, Google Calendar events and the Slack threads the Company Brain captured. Each kind is a source
with a stored config, a bounded sync run, a receipt and stable error codes, and every document it writes carries the
refs that search, graph and brief read (handle, issue, parent, author, assignee, attendee, label, status, due,
starts_at, channel). One shared runner (`runBrainSourceSync`) runs every connectable kind the way the git adapter does.

## Scope of this increment

In scope: `brain/sources/connectors/` (four kind handlers, four adapters, the snapshot engine, the runner, the
`brain_connector_sources` table), tests and this spec. Out of scope, with no stubs: the `/sources` service and routes
(the kinds plug in through `BrainSourcesServiceDeps.handlers` and `runner`) with the option lookups they serve, the
real integration caller, the real Slack capture reader (PR #2078 and #2076 to #2079 supply the captured threads),
registry action code, scheduled syncs and UI (see Deferred). No routes; OS-view surface matrix: N/A (no route or UI).

## Model

- Document ids: `sha256(JSON.stringify([version, externalRef, ...tail]))` with versions from
  `BRAIN_DOCUMENT_ID_VERSIONS`; tails `["issue", id]`, `["comment", id]`, `["project_update", id]`, `["file", fileId]`,
  `["event", calendarId, eventId]`, `["thread", companySourceId]`. Never a content hash.
- External refs: `<kind>:` plus 40 hex of a hash of the account label and the sorted ids (Slack: the company scope
  id), fixed at connect time. Labels: "Linear ENG, OPS", "Google Drive (2 folders)", "Google Calendar (1 calendar)",
  "Slack threads".
- Linear: issue title `ENG-42: Title`, body is the description plus a footer (state, project, labels, due); refs
  handle, issue, author and assignee (`linear:<userId>`), labels (20), status (`open`, `in_progress`, `done`,
  `canceled`), due. Comments: `Comment on ENG-42: Title`, refs issue, parent (the issue document id), author. Project
  updates: `Project update: <name>`, refs author, status from health (`on_track`, `at_risk`, `off_track`).
- Drive: Google Docs the owner may download, exported as plain text; title is the file name; ref author (`email:` of
  the last editor).
- Calendar: one document per event instance; footer with start, end, organizer and attendees (50, rooms left out);
  refs starts_at (UTC; all-day events at UTC midnight), author (organizer), attendee, status. Description and
  location only with `includeEventBodies`; without it a private or confidential event is titled "Private event" and
  the run reports `private_body_omitted`. A config change (calendars or bodies) re-renders every listed event and
  deletes the stored events missing from the listing, past events and events of removed calendars included.
- Slack bridge: one document per captured `slack_thread` whose permalink names a `C` or `G` channel; channel ref
  `<teamId>/<channelId>`; only allowed channels (empty list: all captured channels).
- Bodies are cut to the 64 KiB store limit with a `[truncated]` marker (`body_truncated`); titles are one line of at
  most 300 characters; permalinks are canonical https or empty.

## Sync

- Runner order: strict options, live active source of the adapter's kind, capped in-process guard, open receipt,
  pages until caught up, `pagesPerRun` or the run budget (checked only between pages, so a started page finishes),
  close receipt. Each page is one `applySyncBatch` with `expectedCursor`; provenances outside the kind's list, too
  many upserts or refs, or a bad skip count are `document_invalid` before any write. `documents_changed` is emitted
  after each page that wrote, deleted or replaced a document's refs (`refsChanged`), with that page's ids.
- Linear (cursor `lin1:`): three phases (issues, comments, updates), each a pass over `updatedAt >= since` with
  GraphQL cursor paging; the watermark moves to the newest `updatedAt` seen only when a pass ends. The first pass reads
  365 days back (`history_window_limited`). Archived or trashed items become deletions. A config change starts over.
- Snapshot engine (Drive `gd1:`, Calendar `gc1:`, Slack `sb1:`): the first page of a run lists the remote items, reads
  back the source's stored documents and plans: items whose stamp differs from the stored `source_updated_at`, or
  every item when the render fingerprint (config and render version) changed, resuming at the last re-rendered item;
  deletions for stored documents missing from a complete listing (Drive, Slack; Calendar during a config change, kept
  open by `m` in the cursor until a listing is complete) or reported cancelled (Calendar). Otherwise a calendar source
  keeps at most 2,000 events (oldest deleted first). Work runs oldest first, starting after `r`, the last item the
  previous run handled, so skipped items wait behind newer ones. A build that fails after the page built items ends
  the page.

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| kind handlers, `runBrainSourceSync` | server code | caller-resolved owner id and `BrainScopeKey`; `(owner_id, scope_id)` in every statement | `BrainFeatureError` codes, result codes |
| integration caller (Linear, Drive, Calendar) | the owner's connected account in the integration layer | one owner, read actions only | outcome values, never provider text |
| Slack capture reader | owner authority in the Company Brain service, checked per read | the configured company scope | `forbidden`, `not_found`, `unavailable` |

- Input validation: strict zod configs (team keys `[A-Z][A-Z0-9]{0,9}`, Drive ids `[A-Za-z0-9_-]`, calendar ids
  without whitespace or control characters and never `.` or `..` (one URL path segment), company scope uuid, channel
  ids `C` or `G` only, unique lists, the `BRAIN_SOURCE_CONFIG_LIMITS` counts, no unknown keys, 8 KiB stored JSON);
  provider data through bounded zod schemas; every document then passes the store schemas.
- Error policy: clients see only `source_*` feature codes or sync codes; logs carry event names, codes and error
  names, never provider text, tokens or document content.
- Credentials: none here. Configs never hold tokens; the integration layer keeps accounts.

## Integration wiring

- Startup: `bootstrapBrainConnectorDatabase(db)` once the sources service exists; handlers built with `{ kysely,
  integrations, isConnected, accounts }` go with `runBrainSourceSync` to it (without `isConnected` a kind answers
  `not_configured`; with `accounts` a run uses only its pinned account label, or the owner's single account, else
  `not_connected`, never the first of several). The Slack bridge gets `capture` only after PR #2078 is merged. No kernel, MCP or environment change; the provider timeout is a
  handler option (default 10 s, 1 to 30 s).
- New registry read actions (defined in `packages/gateway/src/integrations/registry-brain.ts`): `linear.brain_issues`,
  `linear.brain_comments`, `linear.brain_project_updates`, `google_drive.brain_list_folder`, `google_drive.brain_export_text`,
  `google_calendar.brain_list_events` (its calendar id refuses `.` and `..` too).

## Failure modes

- Timeouts: each provider call and each capture read races `AbortSignal.any([page signal,
  AbortSignal.timeout(providerTimeoutMs)])`, so a callee that ignores the signal is still cut off; the timeout alone is
  `provider_timeout`. The run budget never aborts a page: the page signal aborts only when the caller aborts
  (`run_budget_exhausted`) or at the 120 s page ceiling (`provider_timeout`), and the runner then stops waiting even
  for an adapter that ignores it (a store read with no timeout).
- Provider outcomes: `not_connected`, `auth_failed`, `rate_limited` (retry hint clamped to 1 s to 1 h),
  `remote_not_found`, `config_invalid`, `provider_unavailable`, `provider_output_invalid`. A Drive export answering
  not found is a skipped item; one answering `auth_failed` (a 403 for that file after the listing worked),
  `config_invalid`, `provider_output_invalid` or `provider_unavailable` is a skipped item (`too_large_skipped`) that
  the next run tries again. Slack: documents of other provenances and threads of other channels are left out; only an
  unreadable `slack_thread` makes the read incomplete (no sweep). A capture read answering forbidden or not found
  (the owner lost the company scope) sweeps every copied thread (past 5,000 stored, one bounded read at a time), then
  the run fails `auth_failed` / `remote_not_found`.
- Concurrency: one run per source per process; across processes the cursor compare-and-set fails the loser
  (`cursor_conflict`, or `source_inactive` when the source was paused or removed). Config saves serialize under the
  feature lock; a save for a source of another kind or a missing source is refused.
- Crash recovery: every page is atomic with its cursor; the next run closes a crashed run's receipt as interrupted;
  snapshot plans are rebuilt from the store and Linear resumes its stored provider cursor.
- Error propagation: adapters return codes; a thrown adapter error is `internal_error` (logged by name); a failed
  receipt close is logged and reported as `receipt: null`; the page after a cut-short page returns its build failure.

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| pages per run, upserts and refs per page, run budget | 20 / 100 / 5,000 / 20 s (ceilings 200 / 200 / 10,000 / 120 s); one page at most 120 s | `runner.ts` |
| provider call timeout | 10 s (handler option, 1 to 30 s; the runner takes no per-run value) | `handlers.ts`, `provider.ts` |
| Linear page size, first window | 100 nodes (fewer when refs per page / 26 is lower), 365 days | `linear.ts` |
| Drive files, folders, depth, list calls, exports per page | 2,000 / 30 / 2 / 40 / 10 | `google-drive.ts` |
| Calendar events per listing and documents kept per source, page size, attendees, list calls | 2,000 / 250 / 50 / 40 | `google-calendar.ts`, `snapshot.ts` |
| Slack threads per read; stored documents read back per plan | 1,000; 5,000 | `slack-bridge.ts`, `snapshot.ts` |
| config lists; stored config | 20 teams, 20 folders, 10 calendars, 50 channels; 8 KiB | `handlers.ts`, SQL CHECK |
| in-process runs; notices per result; rejected ids per result | 16; 16; 100 | `runner.ts` |

Every Map and Set is bounded by these caps and lives for one call or run. Third-party data flow: read requests only.

## Invariants

- **Source of truth**: provider data; the core `brain_*` tables hold copies written only by `applySyncBatch`, and
  `brain_connector_sources` holds the validated configs.
- **Lock/transaction scope**: each page is one store transaction under the core scope lock (repository); config
  writes take `brain-connector:<scopeId>`; provider calls run outside transactions.
- **Acceptable orphan states**: documents of Linear teams removed from a config stay until the source is removed;
  calendar events that left the window stay until the next calendar config change, at most 2,000 per source; the
  store keeps up to 10 earlier revisions of each document (`BRAIN_REVISIONS_PER_DOCUMENT`), so earlier calendar
  bodies stay in that history until the source is removed (`deleteSource` purges it); the sources service therefore
  removes and reconnects a calendar source when `includeEventBodies` goes from on to off. A crashed run's receipt
  stays running until the next run.
- **Auth source of truth**: the request principal resolved to the project scope by the caller; provider access
  through the owner's integration accounts; Slack through live Company Brain owner authority.
- **Deferred scope**: listed below.

## Integration test checkpoint

`pnpm exec vitest run tests/gateway/brain-source-connectors-*.test.ts` (PGlite and fakes, no network) covers the
runner, each adapter end to end through the runner, the handlers and the helpers. Manual (dev Docker stack, after the
`/sources` routes and registry actions land): connect Linear for `proj_db779ebd-56fb-4c55-a253-34add36251b7`, sync
until `nextAction` is empty, then `GET .../why` and search show issue cites with `ENG-N` labels.

## Code review checklist

Every provider read goes through the integration caller (registry read actions only, byte-capped, cancellable, with
a timeout); every page, upsert and ref list is capped; provider text and status never reach a client or a log beyond
codes and error names; an account outage is never read as `not_connected`; no `catch {`; no new dependency.

## Delivery and evidence

- [ ] One PR (2,938 added lines; `runner.ts`, 273 of them, can move to the sources service PR), checks green, Invariants and the OS-view matrix (N/A) in the body.
- [ ] Site docs PR (`FinnaAI/matrix-os-site`): connector sources and their privacy rules.

## Deferred

The `/sources` service and routes with the option lookups (Linear teams, Drive folders, calendars) and the
remove-and-reconnect rule above, the real integration caller, the registry actions, the Slack capture reader over
`CompanyBrainService.export`, scheduled syncs, Drive files other than Google Docs, Linear deletions that leave no
archived record, history beyond 365 days, and the Sources screen.

Landed later in the stack: the `/sources` service and routes (spec 565, `sources/core/`), the real integration caller
(`sources/integration/`), the six registry read actions (`integrations/registry-brain.ts`) and the Sources screen
(spec 563). Still open: the option lookups, the Slack capture reader and scheduled syncs.
