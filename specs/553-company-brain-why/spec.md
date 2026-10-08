# Company Brain why

**Status:** Implementation target (query, project API and agent tool of the brain stack; builds on specs 551, 552)  
**Owner:** gateway `brain` domain (`brain/why.ts`, `brain/refs-reads.ts`, `brain/api/`), kernel `tools/brain-why.ts`  
**Date:** 2026-10-01

## Outcome

Matrix answers "why is this file like this" from a project's synced git history: for a repo-relative file or folder,
the pull requests, commits and spec files that touched it, newest first, with permalinks and their verbatim Summary
and Invariants sections. The owner connects a project's checkout as a git source, syncs it in bounded runs and reads
receipts over `/api/brain/projects/:projectId/...`; the Matrix agent asks with the read-only `brain_why` tool.

## Scope of this increment

In scope: the store read (`refs-reads.ts`, `listDocumentsByRef`, the `brain_documents_recent` index), `brain/why.ts`,
`brain/api/` (service, routes, agent adapter), their wiring, the kernel `tools/brain-why.ts` and tests. Out of scope
(no stubs): organization scopes (spec 124 work), source pause, replace and delete routes, scheduled sync, UI,
fetching, ranking, forge APIs. OS-view surface matrix: N/A (no UI; the tool answers in chat everywhere).

## Projects and scopes

- Owner: the principal's `userId` (routes) or the gateway-bound owner (tool), as `{ type: "user", id }`. An id
  (`^proj_[A-Za-z0-9_-]{1,128}$`) resolves through `getProjectById`, a slug (the agent sees `~/projects/<slug>`; REST
  paths take either) through `getProject`. Anything else, and any lookup 400 or 404 (malformed,
  missing, foreign, archived, deleting), is `project_not_found`; other statuses log the number, `brain_unavailable`.
- Scope: `brainProjectScope` = `{ ownerId, scopeId: "personal:project:<projectId>" }`, never client input. Its git
  source is the oldest live `git` source (`createdAt`, `sourceId`) among the first 100; registering again returns it
  (`created: false`); a different explicit `webBase` is `git_source_conflict`.
- `externalRef`: an explicit `webBase`, else the project's GitHub `htmlUrl` if `parseWebBase` accepts it, else
  `project:<projectId>` (label: the project name, else the slug). No git runs at registration; for `project:<id>` the
  adapter derives the web base from origin on every run (narrowing spec 552's `deriveWebBase(remote)` caller step).
- No collaboration project-fence gating: the brain reads git objects only and writes only the owner's brain scope.

## `brain_why` query

Path: one trailing `/` means folder only (`match: "folder"`); otherwise the path or anything under it
(`file_or_folder`). Raw input is at most 1,024 chars; the stripped path must pass `isIndexablePath` (1..512 bytes; no
control character, leading `/`, or empty, `.` or `..` segment), so `""`, `/`, `a//`, `./a` and the root are invalid.
`listDocumentsByRef` (strict query: `path` refs, provenances `git_pr`, `git_commit`, `git_spec`, extra kind `spec`,
`limit` 1..50, default 10) reads lock-free: live documents with an `EXISTS` matching ref, newest first, `limit + 1`.

- Match: `under` is `value >= v || '/' AND value < v || '0'` ('0' follows '/'); `exact_or_under` adds `value = v`.
  No LIKE or `text_pattern_ops`: `value` is `COLLATE "C"`, so `brain_document_refs_lookup` serves a bytewise range
  scan (nothing to escape; `src/a-b`, `src/a.b`, `src/a0` are not under `src/a/`). The new partial index
  `brain_documents_recent (owner_id, scope_id, source_updated_at DESC, document_id DESC) WHERE deleted_at IS NULL`
  serves the order (six `brain_*` tables, six named indexes).
- Count: the predicate without the cursor, `LIMIT 1001` (`total = min(n, 1000)`, `totalCapped = n > 1000`). Page
  refs: one query, at most 200 per document. Cursor: base64url of `[source_updated_at, documentId]` of the last item,
  the time as UTC ISO with microseconds so the keyset is exact for any stored value; decoded strictly (a malformed
  tuple, an id that is not 64 hex or a year-0000 time Postgres cannot store is `BrainStoreError("invalid")`, a 400).
- Items: `kind` from provenance (`pr`, `commit`, `spec`); `label` by the shared cite rule (`brain/cite.ts`): `#N`
  (`!N` for GitLab), else the sha's first 12 hex; a spec's handle, else its first spec ref, else its title;
  `number` and `sha` from the footer (null for specs); `link` `explicit`
  for a forge merge message (footer `Merged branch:`, or `!N`), `inferred` for spec 552's ` (#N)` subject heuristic,
  else `none`; plus `documentId`, `title`, `date`, `permalink` ("" when none), `summary`, `invariants`, `specs` (4
  brief / 16 full), `matchedPaths` (3 / 20) and `matchedPathCount`. Each spec part is its own item.
- Footer: the last `Commit: <40 or 64 hex>` line followed only by spec 552 footer lines; the message is the text
  before it without trailing blank lines or the truncation marker. No footer: label `PR` or `commit`, link `none`;
  a pull request footer with no number: the short sha, link `none`. No match: `total 0`, `items []`, and callers
  say so plainly.

## Excerpts

- Headings: ATX only, outside backtick or tilde fences, scanned by character. Summary: the heading (at most 200
  chars, lowercased, one trailing `:` dropped) is `summary`, `tl;dr`, `outcome` or starts `summary `; Invariants: it
  matches `\binvariants?\b`. The first non-empty section of each class wins.
- Section: lines after the heading up to the next heading of the same or a higher level, or the end, trimmed of blank
  lines. Fallback (pr and commit without a Summary): the lead paragraph before the first heading, `heading: null`;
  none when it is only the message's closing git trailers (`Co-authored-by: ...`) or only repeats the title (a
  squash list entry `* <title>`).
- Bound: 480 UTF-16 units brief, 4,000 full; cut at the last newline in the second half, else the last space there,
  else hard (never inside a surrogate pair); `truncated: true`, also when a section reaches a truncated message end.
- Verbatim: excerpt text is a substring of the stored body. No rewriting, joining or model call.

## Routes

Mounted at `/api/brain` behind `authMiddleware` (not in `PUBLIC_PATHS`). Each handler: principal; `service === null`
is 503; `projectId` must be a project id or slug (`BRAIN_PROJECT_REF_PATTERN`), else the same 404 as a missing
project; zod (queries through `exactQuery` first: unknown or repeated keys are 400); service call. Responses set
`Cache-Control: private, no-store`; the routes use the shared route guard (`api/feature-route-kit.ts`) and register no
middleware for `*`.

| Method, path | Input | Success | Errors |
| --- | --- | --- | --- |
| POST `/projects/:projectId/git-source` | bodyLimit 4 KiB; empty or strict `{ webBase?: 1..512 }` | 201 `{ source, created: true }`, 200 if existing | 400 401 404 409 413 503 |
| POST `/projects/:projectId/sync` | bodyLimit 1 KiB; empty or strict `{}` | 200 `BrainSyncView` | 400 401 404 409 413 503 |
| GET `/projects/:projectId/receipts` | `limit` 1..50 (10) | 200 `{ source, receipts }` | 400 401 404 503 |
| GET `/projects/:projectId/why` | `path`; `limit` 1..50 (10); `cursor` 1..256; `detail` `brief`/`full` | 200 `BrainWhyResult` | 400 401 404 503 |

`BrainSyncView` echoes no cursors, ids or paths. `BrainWhyResult` is the page plus `source` (`{ sourceId, webBase,
lastSync }`; null with an empty page).

## Sync policy

- One `syncGitSource` run per `POST .../sync`, never a loop: 500 commits and a 20 s budget (spec 552 windows and git
  deadlines otherwise), well under Node's 300 s request timeout; the client repeats on `run_again`. `config: {}`.
- A run that recorded a receipt is a 200 even when `failed`; its receipt says why. Pre-receipt `sync_in_progress`
  (this process) is 409 `sync_in_progress`; `source_unavailable`, `source_inactive`, `source_kind_mismatch` are 409
  `git_source_unavailable`; other codes are logged and 503. A run whose receipt could not be closed is a 200 with
  `receipt: null`. Across processes the cursor compare-and-set decides (the loser records `cursor_conflict`). A client
  abort does not stop a run. `why` never syncs or fetches.

## Agent tool `brain_why`

- `mcp__matrix-os-ipc__brain_why`, `readOnlyHint`, registered and allowed only when the gateway passes `brainTools`;
  not in `IPC_TOOL_NAMES`, `IPC_TOOLS` or approval hooks. Input (zod/v4): `project` (id or slug), `path` (1..1,024,
  no NUL), `limit` 1..50 (default 5, so a default answer stays short), `cursor` 1..256, `detail` (default `brief`);
  never an owner, scope or checkout path.
- Wiring as for `osViewTools`: `createBrainAgentTools(service)` passes through `createDispatcher` and the kernel config
  to `createIpcServer`; the handler runs in the gateway and calls `service.why` for the routes' no-JWT principal
  (`MATRIX_USER_ID` on a trusted single-user gateway, `default` in local dev); no owner or no Postgres: no tool.
- Answers: "That project was not found." (missing or foreign); a fixed hint for a bad path or cursor; "Company Brain
  history is temporarily unavailable." with `isError` otherwise (logged by name); one sentence for no source or match.
  Items: a header (shown, total, `+` when capped, last sync), then per item kind, label, date, title, link annotation,
  permalink, `Summary:` (`Message:` for the lead-paragraph fallback), `Invariants:` (U+2026 when cut), `Specs:`,
  `Paths:` (unless the only match is the path itself), then `More:` with the cursor.
- Hard caps of 8,000 / 32,000 chars include the header and last line; items past the cap are dropped with a hint to
  call again with `limit` set to the shown count (the page's cursor would skip them); an oversized first item is cut.
- Commit, PR and spec text is untrusted: every document string loses Unicode format characters (zero-width, bidi) and
  its CR, VT, FF, NEL, U+2028 and U+2029 become `\n` (excerpt lines stay indented, one-line fields stay on one line),
  so it cannot forge an item, citation, `More:` line or wrapper marker; the answer goes through `wrapExternalContent`.

