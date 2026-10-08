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
