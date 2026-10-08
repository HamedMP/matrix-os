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

## Security architecture

**Auth matrix.** Principals: JWT, platform-verified, `MATRIX_USER_ID` container, or `default` in local dev without an
auth token; a principal error is 401 `{ "error": "Unauthorized" }` (misconfiguration 500, logged by name).

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| POST `.../git-source`, `.../sync` | `authMiddleware` (bearer or platform JWT), `requireRequestPrincipal` | project owned by the principal; scope `personal:project:<id>`; `repoPath` from the project record | 400 401 404 409 413 503 |
| GET `.../receipts`, `.../why` | same | same; read-only | 400 401 404 503 |
| `brain_why` IPC tool | in-process kernel IPC server, agent only | owner bound in the gateway at construction; project resolved for it | fixed texts |
| service, `brainWhy`, `listDocumentsByRef` | server code | caller-resolved scope key; `(owner_id, scope_id)` in every statement | API and store codes |

**Input validation plan.** `projectId` pattern before any lookup; bodyLimit, strict zod bodies; `exactQuery` then
strict zod queries (`path` refined by `normalizeBrainWhyPath`); the same bounds on agent input; `parseWebBase`; strict
store parsing and cursor decoding; bound SQL parameters. `repoPath` only from `resolveProjectWorkingDirectory`.

**Error response policy.** Body `{ "error": { "code", "message" } }` with fixed `BRAIN_API_ERRORS` messages; never
zod issues, paths, stderr, SQL, stacks or another owner's project's existence. Logs (`[brain-api]`, `[brain-agent]`,
`[brain-why]`) carry an error name, numeric status or code only.

| Code | Status | When |
| --- | --- | --- |
| `invalid_request` | 400 | zod or `SyntaxError` at the boundary; bad `webBase`, path or cursor (store `invalid`) |
| `project_not_found` | 404 | malformed id or slug; missing, foreign, archived or deleting project |
| `git_source_missing` / `git_source_conflict` | 409 | no source, store `not_found`/`forbidden` / other `webBase`, store `conflict` |
| `git_source_unavailable` / `checkout_unavailable` | 409 | source paused, removed or not git / no eligible checkout |
| `sync_in_progress` / `brain_capacity` | 409 | a run on this source in this process / store `capacity` |
| `body_too_large` / `brain_unavailable` | 413 / 503 | bodyLimit / no Postgres, index unavailable, receipt-less failure, unknown |

**Credential handling.** No secrets; nothing contacts a remote; permalinks are credential-free https (spec 552).

## Integration wiring

- `startup/owner-database.ts`, after the messaging repository: `services.brainService = await
  startBrainProjectService(kysely, { projects: codingAgentProjectManager, homePath })` builds the repository on the
  shared Kysely, bootstraps it and returns the service; without Postgres it stays `null`.
- `server.ts`: `brainTools: createBrainAgentTools(ownerDatabaseServices?.brainService ?? null)` in `createDispatcher`
  (passed to both kernel configs, then `createIpcServer`, which registers and allows the tool), and
  `app.route("/api/brain", createBrainRoutes({ service, getPrincipal }))` after `authMiddleware`. Dependency injection
  only. `/api/brain` joins the `data-features` route inventory group. No new environment variable.
- Teardown: none; the repository shares the owner Kysely, the service holds no timers or caches, `appDb.destroy()`
  releases the pool. No import cycle (`brain/index.ts` re-exports neither `why.ts` nor `api/`).

## Failure modes

- No Postgres: routes 503, no tool. Brain bootstrap hits a lock or statement deadline (`55P03`, `57014`): logged
  with the code, `brainService` stays `null` (routes 503, no tool) and the next start retries, so an optional feature
  never takes owner data down; any other bootstrap error fails owner startup closed, like the other repositories.
- Project index unavailable or identity conflict: 503, status logged. Checkout missing, a symlink or outside home:
  409 `checkout_unavailable`, no git. Not a repository, shallow, no branch, no web base, git timeout: a failed
  receipt, HTTP 200 with its code and `nextAction`.
- Concurrent sync and abort: see Sync policy. Crash mid-run: spec 552 recovery (`interrupted` receipt, replay).
- Slow database: writes keep the 551 deadlines; reads are bounded by the page, the 1,001-row count and the ref cap; a
  Postgres error is 503, logged by name. Stale history: nothing fetches; `source.lastSync` says how old answers are.

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| why page / total / cursor / raw path | 10 default, 50 max / 1,000 / 256 / 1,024 chars | route, tool and store schemas |
| excerpt; specs; matched paths (brief / full) | 480 / 4,000 units; 4 / 16; 3 / 20 | `why.ts` |
| refs per document / receipts / sources scanned | 200 / 10 default, 50 max / 100 | refs query, route, service |
| bodies / sync per request / tool answer | 4 KiB, 1 KiB / one run, 500 commits, 20 s / 8,000, 32,000 chars | bodyLimit, service, tool |
| memory per why call / long-lived state / third-party data flow | 51 documents of 64 KiB, 10,000 ref rows / spec 552's 16-key guard set; no timers, caches or files / none | page and ref limits |

## Invariants

- Read paths never write; `why` never syncs, fetches or runs git; a sync request is at most one run. Client errors
  are fixed codes. Excerpts are verbatim substrings; `truncated` marks every cut.
- Scope keys come only from the principal (or bound agent owner) and the resolved project id; foreign projects read
  exactly like missing ones. Only live documents match; a cursor walk returns each match once, newest first.
- Source of truth stays the spec 551 store over spec 552's git history; this increment adds one index, no state.
- Acceptable orphan state: deleting a project leaves its `personal:project:<id>` brain scope in Postgres until
  project deletion erases it (Deferred); no route or tool can reach it, since every lookup is `project_not_found`.
- A `project:<id>` source reports `webBase: null` (registration runs no git); item permalinks carry the base the
  adapter derived from origin.

## Integration test checkpoint

PGlite-backed or pure, fixture repositories from `helpers/brain-git-fixture.ts`, no network:
1. `brain-why.test.ts`: file, folder and `exact_or_under` matches (`src/a-b`, `src/a.b`, `src/a0`, `src/ab`
   excluded), tombstones, provenances, scopes, keyset ties, `totalCapped`, bad cursors; a synced fixture; path,
   footer, excerpt and lead-paragraph tables.
2. `brain-api-service.test.ts` (real repository and git, stub lookup): registration, conflicts, foreign and slug
   lookups, one run per `sync()` until caught up, pre-receipt codes, receipts, `why`, the deadline-deferred
   bootstrap, and the agent path end to end (real sync, `createBrainAgentTools`, the kernel handler citing
   `<web base>/pull/1` with `Summary: - Adds alpha.`).
3. `brain-api-routes.test.ts`: statuses and exact bodies, `Cache-Control`, 401 without a service call, malformed id
   equals missing, 400 and 413 inputs, error mapping, logs by name, no leaked internals.
4. `brain-wiring.test.ts` (source order, like `project-deletion-wiring.test.ts`): owner-database starts the brain;
   `server.ts` hands it to `createDispatcher` and mounts `/api/brain` with `requireRequestPrincipal` after
   `authMiddleware`. Plus `brain-why-tool` (forged breaks, zero-width markers, hard caps), kernel registration and
   options, `brain-agent-tools`, `dispatcher-overrides`, `route-inventory`, owner-database suites.

Manual end-to-end (dev Docker stack, principal `default`, full-history clone in `projects/matrix-os`): create the
folder project, `POST .../git-source` (201, `project:<id>`), `POST .../sync` until `nextAction` is not `run_again`,
then `GET .../why?path=packages/gateway/src/project-manager.ts&limit=5`: first-parent PRs #1771, #1328, #1252 with
permalinks and verbatim `## Summary`; `proj_missing` is 404 `project_not_found`.

## Code review checklist

- Routes: bodyLimit, `exactQuery` and strict zod, principal first, one error mapper, no echoed input; foreign equals
  missing. `sync` runs once. No `catch {`; logs carry names or codes. Range predicate, no LIKE; every list, count and
  excerpt bounded; the tool answer cleaned, wrapped and capped; files under 450 LOC; wiring-only server edits.

## Delivery and evidence

- [ ] One PR under 3,000 additions and 50 files, checks green, Invariants and the OS-view matrix (N/A) in the body,
      merged only after Greptile scores its current head 5/5.
- [ ] Site docs PR (`FinnaAI/matrix-os-site`, `content/docs/`): project brain API, `brain_why`, receipts, syncing.

## Relationship to existing work

- Spec 551: adds `listDocumentsByRef` and `brain_documents_recent` and delivers its planned `owner-database.ts` wiring.
  Spec 552: the "next" increment it names; narrows registration (above) and makes its `run_again` loop one run per
  request. Spec 115: delivers its cited-permalink "why" for git. Spec 124: organization projects are
  `project_not_found` until organization brain scopes land. PR #2078's `company-brain/` and `/api/company-brain` are
  unrelated and untouched.

## Deferred

Organization scopes, scheduled sync, UI, source pause and delete routes, fetching, ranking, forge data; erasing a
deleted project's brain scope (a `createProjectDeletionCleanup` hook calling `eraseScope`); renames
(spec 552 uses `--no-renames`, so older history sits under the old path); refs beyond a commit's first 200 paths;
documents of force-pushed-away commits (they answer until a cleanup); matching on `spec` refs.
