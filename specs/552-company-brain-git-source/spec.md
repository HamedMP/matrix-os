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
