# Company Brain git source

**Status:** Implementation target (git source adapter of the brain stack; builds on spec 551)  
**Owner:** gateway `brain` domain (`packages/gateway/src/brain/git/`, plus `brain_document_refs`)  
**Date:** 2026-10-01

## Outcome

Matrix can explain a project from its own git history. A sync reads the default branch of a local
checkout and writes one Brain document per pull request (or per direct commit) and one per spec
file, each with a forge permalink and a bounded list of the paths, PR numbers and spec
directories it touches. The sync is incremental, bounded and resumable: it records the last fully
applied commit, finishes a large repository over several runs, and survives a force-push. A later
`brain_why(path)` answers "which PRs and specs touched this file" from `brain_document_refs`.

This increment ships the adapter and the refs table only: no HTTP routes, agent tools, UI,
startup wiring or cron. It exposes `syncGitSource` for the next increment and a later cron.

## Scope of this increment

In scope:

- `packages/gateway/src/brain/git/`: `types.ts` (contract and limits), `parse.ts` (pure parsers
  and validators), `reader.ts` (bounded git runner, `openGitRepository`), `containment.ts`
  (where a repository may live), `permalinks.ts`, `documents.ts`, `specs.ts`, `window-specs.ts`
  (which touched spec files a window writes), `batches.ts`, `cursor.ts` (cursor forms),
  `sync.ts`, `index.ts`.
- Store extension of spec 551: `brain_document_refs`, `document-refs.ts`, `refs` on sync
  upserts, `listDocumentRefs`, refs removal on every tombstone path (edits to `database.ts`,
  `types.ts`, `schemas.ts`, `documents.ts`, `sources.ts`, `repository.ts`, `brain/DOMAIN.md`).
- Tests: `tests/gateway/brain-git-{parse,reader,reader-containment,documents,mapping-edges,sync,sync-failures,sync-guards}.test.ts`,
  `brain-store-refs.test.ts`, helpers `helpers/brain-git-{fixture,harness,pure}.ts`, edits to the
  551 tests.

Out of scope (no stubs): routes, agent tools, UI, startup wiring, the cron, `brain_why`;
fetching (freshness depends on whoever updates the checkout's remote-tracking refs); forge APIs
(reviews, comments, issues); diffs and source files (only commit messages, changed path names and
spec files are read); any change to PR #2078's `company-brain/`, to `onboarding/`, or to
`brain/index.ts` exports (consumers import `brain/git/index.js`, so there is no import cycle).
There is no user-visible surface, so the OS-view surface matrix is N/A.

## Sources and repository identity

- A git source is a `brain_sources` row with `kind = "git"`, registered by the caller with
  `createSource` (idempotent on `(kind, externalRef)`) before the first sync.
- `externalRef` is the repository identity, used verbatim: a canonical https web base
  (`https://github.com/acme/widgets`; for no usable remote, GitHub Enterprise or self-hosted) or
  an opaque identity (`project:proj_abc123`; 1..512 chars, no NUL) whose web base is derived
  from the origin remote on every run. Caller rule: explicit base, else
  `deriveWebBase(remote)?.href`, else `project:<projectId>`. Ids hash the identity, so they are
  stable across clones, remote URL forms and runs; a re-created source revives its tombstones.

### Web base and permalinks

`resolveGitWebBase({ externalRef, remoteUrl })` is pure and runs on every sync: the base is
`parseWebBase(externalRef) ?? deriveWebBase(remoteUrl)`. Both present and different (compared
lowercased) is `remote_mismatch`; neither is `web_base_unavailable`.

- `deriveWebBase(url)` knows only `github.com` (exactly 2 path segments) and `gitlab.com` (2..20,
  nested groups), in scp form `[user@]host:path` or with `https:`, `http:`, `ssh:` or `git:`. It
  ignores and never echoes username, password and port; rejects over 2,048 chars, whitespace,
  control characters, a query, a fragment and `%`; strips one leading and one trailing `/` and
  one `.git`; segments match `^[A-Za-z0-9_.-]{1,100}$` and do not start with `.`. It returns a
  canonical `https://<host>/<segments>` (`new URL(href).href === href`).
- `parseWebBase(value)` accepts a stored base: at most 512 chars, `https:`, no credentials,
  query or fragment, canonical, no trailing `/`, segments `^[A-Za-z0-9_.~-]{1,100}$` and not `.`
  or `..`; a port is allowed. Flavor is `gitlab` for `gitlab.com` or a `gitlab.` host, else
  `github` (GitHub Enterprise shares its URL shapes).

| Permalink | github flavor | gitlab flavor |
| --- | --- | --- |
| PR | `<base>/pull/<n>` | `<base>/-/merge_requests/<n>` |
| commit | `<base>/commit/<sha>` | `<base>/-/commit/<sha>` |
| spec file | `<base>/blob/<sha>/<path>` | `<base>/-/blob/<sha>/<path>` |

Path segments are encoded with `encodeURIComponent`. Every permalink must be canonical and at
most 2,048 chars; a blob link that fails this falls back to the commit link.

## Documents

Ids are `sha256_hex(JSON.stringify(["brain_git_v1", externalRef, ...tail]))`, never a content
hash. `sourceUpdatedAt` is the committer date (`%cI`) of the commit, or for a spec file of the
newest touching commit.

| Document | Tail | Provenance |
| --- | --- | --- |
| Pull or merge request | `"pr", N` (number) | `git_pr` |
| Commit | `"commit", sha` (full lowercase hex) | `git_commit` |
| Spec file part | `"file", path, part` (number, from 1) | `git_spec` |

### One document per first-parent commit

| Form | Rule | Title (fallback) |
| --- | --- | --- |
| `squash` | 1 parent; subject ends in ` (#N)` or is `(#N)` | subject without ` (#N)` (`Pull request #N`) |
| `merge_titled` | 2+ parents; same subject rule | same |
| `merge_branch` | 2+ parents; subject `Merge pull request #N from <branch>` | first non-empty body line (`Pull request #N`) |
| `gitlab_merge` | gitlab flavor; a body line `See merge request <path>!N` | subject, or for `Merge branch 'a' into 'b'` the first other body line (`Merge request !N`) |
| `commit` | anything else | subject (`Commit <first 12 hex>`) |

- N is 1..999,999,999. `Revert "x (#157)"` and `x (#12) trailing` are commits. It is a
  heuristic: a direct commit whose subject ends in `(#N)` also becomes PR N. Two commits naming
  one PR share its document; the newer wins and the older text stays in revision history. A
  rescan writes such a document twice more (older text, then newer); its final content is the
  same. Knowing that a later commit names the same PR would need every later subject.
  Titles: NUL becomes U+FFFD, whitespace collapses, cut to 300 UTF-16 units (pairs kept whole).
- Body: the message body verbatim (`## Summary`, `## Invariants`, lists, trailers and emoji
  kept; for `merge_branch` the lines after the title line), a blank line, then a fixed footer:
  `Commit: <sha>`, `Author: <name or unknown>`, `Committed: <date>`, `Pull request: #N` or
  `Merge request: !N`, `Merged branch: <branch>` (merge_branch only), and
  `Changed paths: <total>` or `Changed paths: <total> (<k> indexed)`.
- When title plus body would exceed 65,536 bytes, or the message was already cut at 256 KiB,
  the message is cut on a code point boundary and the fixed marker `[Truncated: the rest of this
  text is over the Company Brain document size limit.]` goes before the footer
  (`message_truncated`). The footer is never cut; paths are never listed in the body. Example:
  `feat(brain): alpha (#1)` gives title `feat(brain): alpha` and `.../acme/widgets/pull/1`.

Changed paths come from `git log --first-parent --diff-merges=first-parent --root --no-renames`:
a squash or direct commit lists its own diff, a merge lists `merge^1..merge`, the root commit
lists every file, and a rename counts as both paths. At most 200 paths per commit are kept; the
rest are counted (`paths_truncated`). Refs, in this order, unique on `(kind, value)`:

1. `pr`: the own number (PR documents), then other `#N` in the subject (github flavor), up to 8.
2. `spec`: the spec directory (`specs/<x>` for the default globs) of each changed path under a
   spec glob directory, up to 16. A literal directory that holds another glob's deeper
   directories (`specs` beside `specs/*`) is not a spec directory itself.
3. `path`: changed paths in git order until the document has 200 refs.

### Spec file documents

Globs: default `specs/*/spec.md`, `specs/*/plan.md`, `specs/*/research.md`,
`specs/*/data-model.md`, `specs/*/quickstart.md` and `specs/*.md`, so a spec folder without a
`spec.md` and the top-level spec files are indexed too; each file is its own set of part
documents with ids from its path. Up to 8 globs of up to 200 chars; a literal first segment; at most
one `*` per segment, matching within that segment (so matching is linear in the path length); no
`.` or `..`. A window writes a spec file that one of its first-parent commits touched only when
the file's tree entry at the window end equals its entry at the run's tip (or it is absent at
both): its content is then final for the run. A touched file whose entry still differs is
skipped, because a later first-parent commit up to the tip must change it, and that later window
writes it. Entries come from one `ls-tree` of the touched paths themselves (exact literal paths,
not recursive) at the window end and, for a window before the tip, one more at the tip; content
comes from `cat-file`.

| Case | Upserts | Tombstones | Notice |
| --- | --- | --- | --- |
| Removed, or not a regular file | none | parts 1..8 | none |
| Over 400,000 bytes (never read) | part 1 stub: `This file is <size> bytes, over the 400000 byte indexing limit. Open the permalink to read it.` | parts 2..8 | `spec_file_oversize` |
| Not valid UTF-8 | part 1 stub: `This file is not UTF-8 text and was not indexed.` | parts 2..8 | `spec_file_not_text` |
| Text in n parts | parts 1..n | parts n+1..8 | none |

- Split: parts of at most 60,000 bytes, cut before the last `## ` heading line in the second
  half of the part, else after the last newline there, else on a code point boundary. Joined,
  the parts equal the text (NUL replaced; an empty file is `(empty file)`). If even a hard split
  needs more than 8 parts (only after NUL replacement grows the text), it is stubbed like an oversize
  file, with the body `... needs more than 8 parts once its NUL characters are replaced. ...`.
- Title: the first `# ` heading in the first 4,096 bytes, else the path; with several parts,
  suffix ` (part i of n)`. A file that grows keeps its part 1 id. Permalink: blob at the newest
  touching commit in the window. Refs: `path`, and `spec` when the path has a spec directory
  (a top-level `specs/*.md` file has none).
- A source synced before the wider default indexes the extra files when a later commit touches
  them, or on a rescan from the root. On this repository's history the wider default adds 172
  files and 176 documents (306 files, 311 documents in all, up from 134 and 135).
- A spec document is written with its content at the run's tip, so a first sync writes it once
  and a rescan leaves it `unchanged`: no live spec document ever goes back to older content, and
  a removed file is never revived. Its final state depends only on history, not on window or run
  boundaries. A file that changes and changes back across windows is also written in the earlier
  window (same content, an older touching commit in the permalink), then again: extra revisions,
  never older content. Tombstoning a missing part is a no-op and is not counted.

## Store extension: `brain_document_refs`

- Created in the 551 bootstrap transaction (`CREATE TABLE IF NOT EXISTS`): `owner_id`,
  `scope_id` (1..256 chars), `document_id` (`^[a-f0-9]{64}$`), `kind` (`^[a-z][a-z0-9_]{0,31}$`),
  `value` (`TEXT COLLATE "C"`, 1..512 bytes). Primary key on all five columns; foreign key
  `(owner_id, scope_id, document_id)` to `brain_documents` `ON DELETE CASCADE`; index
  `brain_document_refs_lookup (owner_id, scope_id, kind, value)`. After bootstrap there are six
  `brain_*` tables, five named indexes and six `*_pkey`.
- Generic: any kind-regex `kind`; git writes `path`, `pr`, `spec`. Collation `"C"` makes a
  directory prefix an index range scan. Limits: 200 refs per document (`BRAIN_DOCUMENT_REFS_MAX`),
  10,000 per sync batch (`BRAIN_SYNC_BATCH_MAX_REFS`), values 1..512 UTF-8 bytes without NUL.
- `BrainSyncUpsertInput` adds `refs?: readonly BrainDocumentRef[]` (omitted means none). The
  strict schema rejects duplicates, bad kinds and oversize values as `invalid`, nothing written.
- `applySyncBatch` is the only writer. After each non-rejected upsert it compares the stored set
  with the sent set and replaces it wholesale only when they differ; a refs-only change stays
  `unchanged` at the same revision. Rejected (foreign) upserts leave refs alone.
- Every tombstone path removes refs: document delete, sync deletions, `deleteSource` (before the
  bulk tombstone) and `eraseScope` (refs first). Only live documents have refs. Refs are never
  snapshotted; `upsertDocument` and `reviseDocument` never touch them.
- New read `listDocumentRefs(scope, documentId)`: at most 200 refs by kind then value; empty for
  a missing, tombstoned or out-of-scope document; no lock.

## Sync algorithm

`syncGitSource(options): Promise<GitSyncResult>` never rejects. Options: `repository`, `scope`,
`sourceId`, `repoPath`, `homePath`, optional `config { branch, specGlobs }`, `runner`, `limits`,
`now`. Before a receipt exists, these return a code and record nothing: options fail the strict
schema (`invalid_options`); the same `(ownerId, scopeId, sourceId)` already syncs in this
process, or 16 syncs run (`sync_in_progress`; the key is removed in `finally`); the source is
missing or deleted (`source_unavailable`), not kind `git` (`source_kind_mismatch`) or not
`active` (`source_inactive`); `openSyncReceipt` failures map the same way.

After the receipt opens, any failure closes it `failed` with its code. The run:

1. Read the cursor; open the repository (see Input validation); resolve the web base and tip.
2. No cursor, or an in-progress token without a position: start from the root. A cursor whose
   position (and, when present, the tip its run worked toward) is the tip or an ancestor of it:
   start after the position, or close `succeeded` with zero counts and no batch when the
   position is the tip. Anything else (not one of the cursor forms, a sha that is not an ancestor
   (exit 1, or 128 for a missing object), or read-ahead commits that are gone): history was
   rewritten; start from the root.
3. Loop while commits remain and fewer than `commitsPerRun` are done. Before each later window,
   stop (`run_budget_exhausted`) once `runBudgetMs` has passed; a started window always finishes.
4. A window is up to `commitsPerWindow` first-parent commits, oldest first, ending at commit X.
   If its oldest commit's first parent is not the previous cursor (an ancestor but off the
   first-parent chain), restart from the root once (rewritten); twice is `git_output_malformed`.
5. Build the window's documents (deduplicated by id, newest wins) and the touched spec files
   whose content is final (at most 500 touched paths, sorted; `spec_files_capped` beyond); pack
   them into batches: upserts in order, a batch closing at `upsertsPerBatch` upserts or before an
   upsert would push it over `refsPerBatch` refs; tombstones fill the last batch up to 200, then
   extra batches of 200; an empty window is one empty batch.
6. Apply the batches in order with `applySyncBatch`. The first batch moves the cursor to this
   run's in-progress token, later non-final batches keep it, and only the final batch moves it to
   X (with `>tip` when X is not the tip). A competing run's batch then fails its compare-and-set
   before it writes anything; a crash leaves the token, and the next run takes it over through
   the same compare-and-set and replays the window.

Cursor forms (`git/cursor.ts`), shas 40 or 64 lowercase hex:

| Form | Meaning |
| --- | --- |
| `<sha>` | every window up to `<sha>` is applied, and `<sha>` was the tip of the run that applied it |
| `<sha>><tip>` | every window up to `<sha>` is applied; the run stopped before `<tip>`, and spec documents may already hold their content at `<tip>`, so a later tip that does not contain `<tip>` forces a rescan |
| `[<sha>]><tip>@<receiptId>` | the run with that receipt is applying the window after `<sha>` (after the root when empty) toward `<tip>` |

Result and receipt:

- `status`: `failed` on error; `partial` when the store rejected an upsert (the id is live and
  owned by manual publication or another source); else `succeeded`.
- `errorCode`: the failure; else `documents_rejected`; else `history_rewritten`; else null.
  `nextAction`: `run_again` when commits remain, the Error policy mapping on failure, else `""`.
- Counts: `read` = upserts plus tombstones that hit a live document (so `read` = `written` +
  `unchanged` + `deleted` + `failed`; the no-op part tombstones a spec file sends are not
  counted), `written` = created plus updated, `unchanged`, `deleted`, `failed` = rejected
  upserts. The result adds `cursorBefore` and `cursorAfter` (the stored text, last committed),
  `commitsProcessed`, `commitsRemaining` (0 after a failure), `caughtUp`, `historyRewritten`,
  `batches`, `rejectedDocumentIds` (at most 100) and `notices` (unique, first-seen order, not
  stored). If closing the receipt fails (a concurrent run or a source
  delete interrupted it), it is logged and `receipt` is null.

## Git invocation

- Tip: a configured branch tries `refs/remotes/origin/<b>` then `refs/heads/<b>` only. With no
  branch: the target of `refs/remotes/origin/HEAD`, then `main`, then `master`, remote-tracking
  first. `HEAD` and the working tree are never read, so a dirty checkout on a feature branch
  does not matter. Nothing resolves: `branch_unavailable`.
- Runner: `execFile("git", argv)`, no shell, `cwd` = the repository's real path, `timeout` =
  `gitTimeoutMs`, a per-command `maxBuffer`, `encoding: "buffer"`, and an environment built from
  scratch: `PATH` (absolute entries only: the child starts in the repository, so an empty or
  relative entry would find a `git` file committed at its root), `HOME`, `LC_ALL=C`,
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`,
  `GIT_NO_LAZY_FETCH=1`, `GIT_ALLOW_PROTOCOL=none` and a few more fixed overrides (no pager, no
  replace objects, no optional locks). Git reads a repo-local `protocol.<name>.allow` before
  `protocol.allow`, and git before 2.45 ignores `GIT_NO_LAZY_FETCH`, so `GIT_ALLOW_PROTOCOL=none`
  is what blocks every transport, a partial clone's lazy fetch included, whatever the
  repository's config says. No inherited `GIT_*` variable or token reaches git.
- Every argv starts with `--no-pager --no-replace-objects --literal-pathspecs
  --no-optional-locks` and pinned `-c` settings (`core.fsmonitor=false`,
  `core.hooksPath=/dev/null`, `log.showSignature=false`, `log.mailmap=false`,
  `diff.renames=false`, `color.ui=false`, `protocol.allow=never`, UTF-8 output); with the
  environment above, repo-local config cannot run a program, sign, page or reach the network. Diffs add `--no-ext-diff
  --no-textconv`; revision arguments end with a literal `--`. Only read commands run.
- A non-zero exit resolves with its code; timeout, output over `maxBuffer` (unless the call
  asked to truncate) and spawn failure reject as `GitRunnerError`. A window log over 16 MiB
  falls back to one commit at a time with truncation (message 256 KiB, paths 1 MiB).

## Error policy

`GitSourceError` and `GitRunnerError` carry a code and a fixed message ("Git source request
failed", "Git command failed"). Callers see only codes.

| nextAction | Codes |
| --- | --- |
| `retry_later` | `git_timeout`, `cursor_conflict`, `store_unavailable`, `sync_in_progress` |
| `fix_source` | `not_a_repository`, `shallow_repository`, `branch_unavailable`, `web_base_unavailable`, `remote_mismatch`, `git_unavailable`, `git_version_unsupported`, `invalid_options`, `source_unavailable`, `source_inactive`, `source_kind_mismatch` |
| `raise_capacity` | `brain_capacity` |
| `contact_support` | `git_output_too_large`, `git_output_malformed`, `git_command_failed`, `document_invalid`, `internal_error` |

Store errors: `capacity` is `brain_capacity`; `conflict` is `source_inactive` when a re-read
shows the source is no longer active, else `cursor_conflict`; `not_found` is
`source_unavailable`; `invalid` is `document_invalid` (logged as an adapter bug); `forbidden` and
unknown errors are `internal_error`. A non-store error from a store call is `store_unavailable`.

## Security architecture

### Auth matrix

No route, WebSocket, webhook or IPC tool is added; the trust boundary is the function call. File
I/O is read-only (`realpath`, `stat`, git reading the repository); nothing is written anywhere.

| Entry point | Authentication / authorization | Scope and path enforcement | Errors |
| --- | --- | --- | --- |
| HTTP routes, agent tools, IPC | none in this increment | n/a | n/a |
| `syncGitSource` | server code only; the caller authorizes the `BrainScopeKey` (spec 551 rules) and the principal's access to the project, and resolves `repoPath` from its project record and `homePath` from Matrix home config, never from raw client input | every store call bound to the key; source live, active, kind `git`, in this scope; `realpath(repoPath)` strictly inside `realpath(homePath)` | result codes |
| `openGitRepository` | server code (sync) | containment; top level only; not shallow; git 2.32+ | `GitSourceError` |
| `defaultGitRunner` | adapter internal | argv only, no shell, scrubbed env | `GitRunnerError` |
| `deriveWebBase`, `parseWebBase`, `resolveGitWebBase` | pure | none needed | null or code |
| `applySyncBatch` with `refs`, `listDocumentRefs` | caller-resolved key, as spec 551 | `(owner_id, scope_id)` in every statement; refs only on the batch source's live documents | `invalid`, `not_found`, `conflict`, `capacity` |

### Input validation plan

- Options: one strict Zod schema (`zod/v4`): `sourceId` by `BrainSourceIdSchema`; `repoPath` and
  `homePath` absolute, 1..4096 chars, no NUL; `branch` null or a safe branch name; `specGlobs`
  1..8 valid globs; `limits` integers >= 1, clamped. Failure is `invalid_options`, before I/O.
- Repository path: both paths go through `realpath`. The repository must be strictly inside home
  (never home itself, so Matrix home's own history is not read; never outside), a directory, and
  equal to the `realpath` of git's `--show-toplevel`. The `realpath` of git's
  `--absolute-git-dir` and `--git-common-dir`, and of every `objects/info/alternates` entry
  (followed up to 5 levels, at most 64 entries, quoted entries refused), must also be strictly
  inside home and never in or under home's own `.git`, so a `.git` file or symlink or an
  alternates file cannot lead to history outside home or to home's own. A subdirectory, a
  folder in a versioned home, such a git directory, a missing path, a symlink loop and git's
  "dubious ownership" refusal give `not_a_repository`; a shallow clone gives
  `shallow_repository`.
- Branch names: at most 200 chars matching `GIT_BRANCH_NAME_PATTERN` (no leading `-`, `/` or
  `.`; not `HEAD` or `refs/...`; no `..`, `//`, `/.`, `@{` or `.lock`); the origin/HEAD target
  must be under `refs/remotes/origin/` and pass the same check. Refs are built by the reader and
  passed after `--end-of-options`. Every sha from git output or the stored cursor matches the
  object-format pattern (40 or 64 lowercase hex) before it reaches an argv.
- Remote URL: local config only, first line, at most 2,048 chars, no control characters, then
  the `deriveWebBase` rules. It is parsed, never fetched, stored or logged: no SSRF surface.
- Git output: parsed strictly; an unknown shape is `git_output_malformed`. Paths decode with a
  fatal UTF-8 decoder and must be 1..512 bytes with no control character, leading `/`, or empty,
  `.` or `..` segment; others are dropped and counted (`invalid_paths_dropped`). Messages decode
  lossily with NUL replaced; author names lose control characters and are capped at 200 chars;
  dates are strict ISO 8601 with offset; at most 64 parents. Output to the store passes the
  store's strict schemas; a bad draft is `document_invalid` with nothing written.

### Error response policy

Results and receipts carry codes and slugs only. stderr, paths, remote URLs, commit text and
Postgres messages never reach a result, a receipt or a thrown message. Server logs use the
prefix `[brain-git]` with only `err.name`, `err.message`, the git subcommand, the exit code and
at most 500 chars of stderr. The next increment maps codes to user copy.

### Credential handling

The adapter holds and needs no secrets. It never contacts the remote, so no credential helper or
SSH key runs, and the child environment carries no gateway token. A remote such as
`https://user:token@github.com/o/r` yields only `https://github.com/o/r`; credentials are never
stored, logged or echoed; `parseWebBase` rejects a base with credentials. No emails are read.

## Integration wiring

Nothing is wired here and no production code imports `brain/git/`. Its public surface is
`brain/git/index.ts`: `syncGitSource`, `defaultGitRunner`, `openGitRepository`,
`deriveWebBase`, `parseWebBase`, `resolveGitWebBase`, and the types and limits of
`git/types.ts`. Startup sequence: none; no `new X()` is added to `server.ts`. Planned use (next
increment): the `BrainRepository` from spec 551's planned wiring in `startup/owner-database.ts`
is injected into a brain service, which authorizes the scope, resolves the checkout path and
Matrix home, calls `createSource(scope, { kind: "git", externalRef, label })`, then
`syncGitSource({ repository, scope, sourceId, repoPath, homePath })` while `nextAction` is
`run_again`. A later cron makes the same call.

Cross-package communication: none; no `globalThis`, no IPC; the repository and runner are
injected. Config injection: `GitSyncOptions` (`config`, `limits`, `runner`, `now`), limits
clamped to `GIT_SYNC_LIMIT_CEILINGS`. The adapter reads no environment variable; the default
runner copies `PATH` and `HOME` into the child. Callers pass the same `config` on every run.

## Failure modes

- Timeouts: every git process has `timeout` (default 15 s, ceiling 60 s, SIGTERM), so a hung
  git, a slow disk or a huge repository gives `git_timeout`, not a stalled run. The run budget
  (default 120 s, ceiling 600 s) is checked before each window. Store transactions keep the 551
  deadlines (5 s lock, 15 s statement). There is no `fetch`, so no `AbortSignal`.
- Rewritten history: a force-push, a garbage-collected cursor object, a cursor off the
  first-parent chain, or a stopped run's read-ahead tip that the branch no longer contains starts
  a rescan from the root, bounded by `commitsPerRun` per run. Documents still on the new history
  come out `unchanged` (same id and content hash), spec documents included, between runs as well
  as at the end; the result is `succeeded` with `historyRewritten` and `errorCode:
  "history_rewritten"`. Exceptions with extra revisions but the same final content: a PR number
  named by two first-parent commits, and a spec file that changes and changes back across
  windows. Documents of dropped commits stay live (Deferred).
- Concurrent access: one run per source per process (guard set). Across processes the cursor
  compare-and-set decides. A window's first batch moves the cursor to the run's in-progress
  token, so a run that read the cursor before that fails on its first batch with
  `cursor_conflict` and writes nothing; a run that read the token takes the window over the same
  way, and the run it displaced fails on its next batch. A source paused or deleted mid-run gives
  `source_inactive` or `source_unavailable`.
- Crash recovery: each batch is one transaction. A crash mid-window leaves the in-progress token;
  the next run takes it over and replays the window; replayed documents are `unchanged` and equal
  ref sets are not rewritten. The next run closes the
  `running` receipt as `interrupted` (spec 551). The adapter writes no files. Windows committed
  before any failure stay, `cursorAfter` says where, and the next run resumes there.
- Error propagation: every failure is returned as a result and closes the receipt `failed`; every
  catch checks the error type and rethrows or logs it; no fire-and-forget promise.
- Repository state: git missing or older than 2.32, shallow, not a top level, no branch, no web
  base, or a mismatching remote each fail the run with a `fix_source` code.
- Large content: long messages are truncated with the marker, paths over 200 are capped, big
  spec files are split or stubbed, non-UTF-8 paths and spec files are dropped or stubbed with a
  notice. None of these fails the run. The scope document or byte cap gives `brain_capacity`.
- Moving refs: the tip is resolved once per run, so a push during a run is picked up next run. A
  local-only commit (no remote-tracking ref) gets a permalink that works once it is pushed.
- Shutdown: no timers or subscribers. A run in flight is abandoned; git children are not
  detached and stop when their output pipe closes; the next run replays the window.

## Resource management

| Limit | Default (ceiling) | Enforced in |
| --- | --- | --- |
| commits per run / per window | 1,000 (10,000) / 50 (100) | sync loop; reader rejects a larger window |
| upserts / refs per batch | 100 (200) / 5,000 (10,000) | batch packer; store schema |
| git process timeout / run budget | 15 s (60 s) / 120 s (600 s) | runner / sync loop |
| concurrent syncs per process | 16 | guard set, cleared in `finally` |
| stderr kept / small command output | 4,096 bytes / 64 KiB | runner / reader |
| window metadata and name-status logs | 16 MiB each, then per commit | reader |
| one message / one commit's paths / `ls-tree` | 256 KiB / 1 MiB (truncated) / 1 MiB (at most 500 exact paths) | reader |
| remote URL / author name | 2,048 / 200 chars | reader, parser |
| paths per commit; refs per document | 200; 200 (`pr` 8, `spec` 16) | parser, documents |
| ref value / spec globs | 512 bytes / 8 of 200 chars | parser and store / options schema |
| spec part / parts per file / file read | 60,000 bytes / 8 / 400,000 bytes | specs |
| spec files per window / rejected ids in a result | 500 / 100 | sync loop / result |

- The 551 limits still apply (64 KiB per document, 300-char title, 2,048-char permalink, 200
  upserts and 200 tombstones per batch, 10,000 documents and 256 MiB per scope); more
  first-parent commits than the document cap stop with `brain_capacity`.
- Memory per window: the raw logs (16 MiB each plus 1 MiB of `ls-tree`), one window of documents
  and the touched spec files (worst case 500 files of 400,000 bytes). The only long-lived state
  is the guard set (at most 16 keys). Files: none written. Child processes: one at a time.
- Third-party data flow: none (permalinks are only text); messages, author names, paths and spec
  text go only into the owner's Postgres scope.

## Invariants

- Source of truth: the repository's first-parent history on its default branch, read-only. The
  documents and refs are a derived index a rescan rebuilds; the cursor is in the store only.
- Lock and transaction scope: git runs outside any transaction. Each batch is one
  `applySyncBatch` transaction under the 551 scope lock, where documents, refs and the cursor
  commit together. No git process or network call runs inside a transaction.
- Cursor: the sha of the last first-parent commit whose window was fully applied, with the
  run's tip when the run stopped short of it, or the in-progress token of the run applying the
  next window. Only a window's final batch moves the applied position.
- Determinism: ids come from the identity tuple, never content; the same history gives the same
  documents and refs however it is split. Only live documents have refs, exactly the last set.
- Acceptable orphan states: documents of commits dropped by a force-push; an in-progress
  cursor left by a crashed run (the next run takes it over); spec documents ahead of the cursor
  (their content at a stopped run's tip); spec files over the per-window cap until touched again.
- Auth source of truth: the caller-resolved scope key, `repoPath` and `homePath`; the adapter
  re-checks containment and never widens either. Deferred scope: listed under Deferred.

## Integration test checkpoint

Fixture repositories are built in a temp Matrix home with git plumbing only (`commit-tree`,
`update-ref`, ...), fixed identities and dates, so shas are deterministic; they never touch the
matrix-os checkout. The store is the 551 PGlite harness.

1. Parsers and reader: logs with `\x1f`, invalid UTF-8, an empty commit, a root commit, a
   40-hex path, R/C statuses, 250 paths capped at 200, truncation and garbage; exact-path
   `ls-tree`; every classification case; validators; hostile globs and a 256 KiB GitLab subject in
   linear time; argv prefix, cwd, timeout, buffers and exit codes; per-commit fallback;
   containment, including a `.git` file or symlink to a repository outside home or to home's own
   `.git`, and alternates outside home; a planted `git` behind an empty `PATH` entry; a repo-local
   `protocol.ext.allow` that `GIT_ALLOW_PROTOCOL` still blocks; shallow clone; tip selection never
   reading `HEAD`.
2. Mapping: every remote URL form (scp, ssh with port, https with credentials, http, git, nested
   GitLab groups, enterprise host, `%`, three GitHub segments); permalinks with special
   characters; ids recomputed by hand; the squash example byte for byte; a 70 KB body truncated
   with the footer kept; refs order and caps; spec split, stubs, shrink; batch packing.
3. Sync: the base history gives exact ids, titles, bodies, permalinks, provenance, dates and
   refs (the merge PR has the paths of `merge^1..merge`), cursor at the tip, receipt
   `succeeded`; a second sync makes zero `applySyncBatch` calls; one new commit creates one
   document; a multi-run sync (`commitsPerRun: 2`, `commitsPerWindow: 1`) returns `run_again`
   until caught up and equals a single run; a window spilled over batches holds the in-progress
   cursor, and after a crash the next run takes it over and replays as `unchanged`; specs, branch
   selection, GitLab merge requests, scope isolation and `eraseScope`.
4. Failures: force-push, a rescan over several runs that leaves every document (specs
   included) exactly as before between runs, read-ahead commits force-pushed away,
   off-first-parent, a garbage-collected or unknown cursor, every fake-runner code, partial
   progress then resume, web base, repository and source-state cases, concurrency in one process
   and across two (the second run conflicts before it writes), capacity, a foreign document
   (`partial`), a source paused mid-run.
5. Store refs: lifecycle, replay, refs-only change, foreign reject, revive, `deleteSource`,
   `eraseScope`, bounds (201 refs, duplicate, bad kind, NUL, 513 and 512 bytes), and the git
   limits fit the store limits. Every spec 551 test still passes.

End-to-end path: fixture repository, `createSource`, `syncGitSource` with real git through
`defaultGitRunner`, `applySyncBatch` with refs, cursor and receipt, `listDocumentRefs`,
`getDocument`, then a force-push and a resync. No route exists yet, so there is no HTTP test.

```bash
bun run typecheck
bun run check:patterns
pnpm exec vitest run tests/gateway/brain-git-*.test.ts tests/gateway/brain-store-refs.test.ts \
  tests/gateway/brain-store.test.ts tests/gateway/brain-store-sync.test.ts
MATRIX_TEST_POSTGRES_URL=postgresql://user:pass@localhost:5432/disposable \
  pnpm exec vitest run tests/gateway/brain-store-postgres.test.ts
```

Manual verification: clone `https://github.com/HamedMP/matrix-os` with full history into a temp
home, register it with that URL as `externalRef`, and sync into a disposable Postgres (the dev
compose `postgres:16-alpine`) until `caughtUp`; about 2,000 first-parent commits take two runs.
Check that a recent squash PR keeps its `## Summary` verbatim and links to `/pull/<n>`, that
`listDocumentRefs` lists its files, that a spec links to a blob at a sha, and that a second run
makes no batch. No image or compose change ships; the gateway host needs git 2.32 or newer.

## Code review checklist

- Every git call goes through the runner: `execFile` with an argv, no shell, `timeout`,
  `maxBuffer`, `encoding: "buffer"`, the scrubbed env, the global args, `--` after revisions,
  `--no-ext-diff --no-textconv` on diffs.
- No value reaches an argv unvalidated (sha, branch, indexable spec path). `HEAD` and the working tree
  are never read; nothing is written to the repository. Containment runs before any git call.
- No `catch {`; every catch checks the type and rethrows or logs. `syncGitSource` never rejects,
  and every failure after the receipt opens closes it. No stderr, path, remote URL or commit
  text in a result, receipt or error message.
- A window's first batch takes the cursor (in-progress token) and only its final batch advances
  it; replays are no-ops; refs ride in the same transaction as their documents. Ids never hash
  content.
- Every buffer, list and map is bounded by a named `git/types.ts` constant; the guard set is
  cleared in `finally`. Refs statements carry `(owner_id, scope_id)`; tombstones remove refs.
- No `as` cast skips validation; Zod from `zod/v4`; relative imports end in `.js`; type-only
  imports use `import type`. Files under `brain/` stay under 450 LOC, tests under 500. Nothing
  touches `startup/`, `server.ts`, `onboarding/` or `company-brain/`.

## Delivery and evidence

- [ ] Five stacked PRs, each under the 3,000-addition limit (about 5,900 lines in all), each
      with typecheck, pattern check and its brain tests green, the Invariants and the OS-view
      surface matrix as N/A in the body, merged only after Greptile scores its current head 5/5:
      1. This spec, its checklist and the spec 551 amendments (about 600).
      2. The refs store extension: `document-refs.ts`; the `database.ts`, `types.ts`,
         `schemas.ts`, `documents.ts`, `sources.ts` and `repository.ts` edits;
         `brain-store-refs.test.ts`, the 551 test and helper edits, and the `brain/DOMAIN.md`
         refs paragraph (about 400).
      3. The pure adapter: `git/types.ts`, `parse.ts`, `permalinks.ts`, `documents.ts`,
         `specs.ts`, `batches.ts`, `cursor.ts`, `helpers/brain-git-pure.ts` and the parse,
         documents and mapping-edges tests (about 2,550).
      4. Git reads: `reader.ts`, `containment.ts`, `helpers/brain-git-fixture.ts`, and the reader
         and reader-containment tests (about 1,400).
      5. The sync: `window-specs.ts`, `sync.ts`, `git/index.ts`, `helpers/brain-git-harness.ts`,
         the three sync suites and the `brain/DOMAIN.md` adapter section (about 1,800).
- [ ] Next: `brain_why(path)` over `brain_document_refs`, the brain service, startup wiring and
      call sites, with an auth matrix for real routes and tools. Later: the scheduled sync.
- [ ] Site docs PR (`FinnaAI/matrix-os-site`, `content/docs/`), separate, with the first
      user-visible increment: a git source section (what is indexed, PR and spec documents,
      permalinks, receipts, force-push behavior). Nothing is user-visible in this PR.

## Relationship to existing work

- Spec 551 (store): this increment writes only through `BrainRepository` (`getSource`,
  `getSyncCursor`, `applySyncBatch`, receipts; `createSource` by the caller) and adds one table
  with the same scope rules, CHECK mirroring, bootstrap and lock. As the first sync adapter it
  takes on the duties 551 gives adapters: provider deadlines, codes instead of provider text,
  nothing secret in cursors. Ids follow the 551 recipe. 551 counts five tables and four named
  indexes; now there are six and five.
- PR #2078 (`origin/codex/slack-company-brain-store`, `company-brain/`): untouched. Its
  `company_brain_documents.provenance` CHECK allows only `manually_published` and `slack_thread`,
  so the later bridge must map `git_pr`, `git_commit`, `git_spec` or extend it. Git permalinks are
  credential-free https, as #2078 requires. #2078 has no refs table; refs stay in `brain_*`.
- Spec 115 (`specs/115-knowledge-engine-demo/spec.md`, only on branch
  `origin/115-knowledge-engine-demo`; main's `specs/115-*` is a different spec): GitHub is a
  launch company and engineering source. For local git history this adapter provides FR-014 and
  FR-015 (durable sync with progress, retries, deduplication, edits, deletions), FR-013 (direct
  local source), FR-016 (bounded receipts), FR-006 and FR-018 (identity, permalink, observed
  time, scope), FR-022 (deterministic cursor), FR-054 and FR-077 (no paths or raw errors),
  FR-073 to FR-076 (bounds, timeouts, no remote access) and SC-004 (an unchanged resync writes
  nothing). Forge data, permission changes, extraction state and FR-020 are not covered.

## Deferred

- Routes, agent tools, UI, startup wiring, the cron and `brain_why(path)`; fetching.
- Tombstoning documents of commits dropped by a force-push (a cleanup can page
  `listDocuments({ sourceId })` and diff against the recomputed id set).
- Re-indexing when `specGlobs` changes (a change needs a new source); `#N` in commit bodies and
  GitLab `!N` mentions as refs (a real history has hundreds of bodies naming other PRs); other
  forges (Bitbucket, Gitea need an explicit base and get GitHub URL shapes); shallow
  repositories (refused).
- For `brain_why(path)`: a commit with more than 200 changed paths keeps only the first 200 in
  git order as refs (a commit that adds `node_modules/` keeps 200 of those), so such commits are
  missed for most of their paths; the footer still states the total.
- Throughput: each window runs one `rev-list --skip` over the remaining range (quadratic in
  windows on a very long history; one bounded `rev-list` per run would list every window end),
  and each spec blob is one `cat-file` process (`cat-file --batch` would be cheaper). On a
  2,000-commit history the store dominates the run time.
- Secret scanning of commit messages and spec text (551 leaves secret stripping to adapters;
  this one reads no diffs or source files, but messages and specs can still hold secrets).
