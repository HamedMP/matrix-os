# Company Brain Matrix sources

**Status:** Implementation target (sources layer of the brain stack; builds on specs 551 to 554)  
**Owner:** gateway `brain` domain (`brain/sources/matrix/`)  
**Date:** 2026-10-02

## Outcome

The owner can add their own Matrix content to a project's Company Brain: their Notes, text files under home folders
they choose, and the chats they opt in one by one. Each becomes a source of the project scope with its own config,
cursor and receipts, synced in bounded runs through the shared sources service and runner (spec 560). Deleted notes,
files and chats become tombstones.

## Scope of this increment

In scope: `brain/sources/matrix/` (config table, three kind handlers, three adapters, the notes reader over the owner
app database), `DOMAIN.md`, tests. The handlers plug into `createBrainSourcesService`; this folder adds no routes.
Out of scope (no stubs): see Deferred. OS-view surface matrix: N/A (no UI here; the Company Brain app shows sources).

## Model

- Table `brain_matrix_sources`: `(owner_id, scope_id, source_id)` primary key, `kind` in the three Matrix kinds,
  `config` JSONB object of at most 8 KiB, `updated_at`. It references `brain_sources ON DELETE CASCADE`. Created by
  `bootstrapBrainMatrixDatabase` under the `brain_matrix_schema` lock with `lock_timeout 5s` and
  `statement_timeout 30s`; writes take `brain-matrix:<scopeId>`.
- Configs (strict zod, sorted and de-duplicated lists):

| Kind | Config | Identity (externalRef) | Per project |
| --- | --- | --- | --- |
| `matrix_notes` | `folders`: 0 to 20 tags (Notes has tags, not folders); empty is every note | `matrix_notes` | 1 |
| `matrix_files` | `roots`: 1 to 8 home-relative folders; `extensions`: 1 to 32 (default: common text types); `maxFileBytes`: 1 to 1 MiB (default 256 KiB) | `matrix_files:` + first 32 hex of sha256 of the roots | 4 |
| `matrix_chat` | `chatIds`: 1 to 50 chat ids | `matrix_chat` | 1 |

- Documents: one per note (`matrix_note`, refs `label`), one per text file (`matrix_file`, ref `file` = home-relative
  path), one per chat, UTC day and part (`matrix_chat`, refs `chat` and `participant` `matrix:<user id>`). Ids are
  sha256 of `[version, externalRef, ...tail]`. Bodies and titles are cleaned (no NUL, no lone surrogate) and cut to
  the store's 64 KiB document bound (`body_truncated`).
- Chat days: a day group starts at a message and takes every next message whose UTC day is not later, so groups
  depend only on message order. Lines are `[HH:MM] role: text` for committed user and assistant text. Parts hold at
  most 60,000 bytes; a day keeps at most 8 parts and 2,000 messages, the rest is read past (`items_truncated`).

## Sync

Every run continues one pass: a scan, then a sweep over the source's live documents. Only the end of the sweep is
`caughtUp`, and the cursor then starts the next pass. The store skips unchanged content, so a pass rewrites nothing
that did not change.

- Notes: notes in id order (at most 5,000 per pass), tag filter applied in SQL to every tag of the column (only the
  label refs come from the first 2,000 characters); the sweep keeps documents of selected notes.
  A page ends before a note whose label refs would pass `maxRefs`; page limits below 20 refs or 1 upsert answer
  `invalid_options`, so the first note of a page always fits.
- Files: each root walked depth first in name order, resumable after any path; hidden names, `node_modules`, folders
  with a secret-like name (see Security), symlinks, depth over 12 and paths over 512 bytes are left out, and so is a
  folder over 5,000 entries, whole (`items_truncated`). Too large,
  binary (NUL byte or invalid utf8), empty and secret-like files are skipped and an earlier document of them is
  tombstoned; a file skipped by a secret-like name or content, or a folder left out by its name, adds the notice
  `secret_skipped`. Every byte read counts against the page's 16 MiB read budget, binary files included; a file larger
  than what is left of it ends the page and is read first on the next one. The sweep keeps a document only while its
  file is a regular file inside a current root, of a selected extension, within the size bound, with no symlink,
  secret-like name or folder over 5,000 entries on the way; a sweep page reads at most 65,000 entries for that.
- Chats: chats in id order, messages in seq order through `getMessages`; a whole day group always fits in one page.
  A chat that is missing or not the owner's is skipped; the sweep removes documents of chats no longer opted in or
  gone.

## Routes

None in this folder. The sources service (spec 560) serves `GET/POST /api/brain/projects/:projectId/sources`,
`GET .../sources/options?kind=matrix_files|matrix_chat`, `PATCH/DELETE .../sources/:sourceId`,
`POST .../sources/:sourceId/sync` and `GET .../sources/:sourceId/receipts` with these handlers. Options: files lists
sub-folders of `q` (home when empty), reading at most 5,000 directory entries; a `q` that is a symlink or a file, or
a missing home, is `source_config_invalid` (400) and an unreadable folder lists nothing. Chats lists the owner's
active chats, newest first, filtered by `q`.

## Security architecture

| Entry point | Authentication | Authorization and scope | Errors |
| --- | --- | --- | --- |
| `/sources` routes (spec 560) | `authMiddleware`, `requireRequestPrincipal` | project of the principal; scope `personal:project:<id>` | `BRAIN_FEATURE_ERRORS` |
| handlers and adapters | server code | caller-resolved scope; chats only through owner-scoped `ChatRepository` calls | result codes, `source_config_invalid` |

Validation: strict zod configs and cursors, bounded lists and strings, roots refused when absolute, hidden, `..`,
`system`, `agents`, holding `data/browser-profiles`, nested, or holding a secret-like name; run-time realpath
containment; `O_NOFOLLOW` opens of the same regular file at read time, with the parent folder rechecked to resolve
to itself; fixed SQL with bound parameters for notes.

Secret-like names: a file or folder name is never read (and never part of a root) when it contains, as a whole word
between `.`, `_`, `-` or the ends of the name, `secret(s)`, `credential(s)`, `creds`, `password(s)`, `passwd`,
`token(s)`, `api-key(s)`, `private-key(s)` or `service-account(s)` (any case; `-`, `_` or nothing inside the two-word
forms), contains `serviceaccount`, `adminsdk`, `kubeconfig`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `sa-key` or
`google-services` anywhere, or ends in `.pem`, `.key`, `.p12`, `.pfx`, `.keystore`, `.jks` or `.tfvars`. A file whose
text holds a private key block, an AWS access key id, a GitHub, Slack or Anthropic token, or a service account JSON
(`"type": "service_account"` with a `private_key`) is skipped the same way, whatever its name. Such files would
otherwise become searchable and readable through brain search and the agent read tools. Code files with these words in their names (for example
`token.ts`) are left out as well; the rule prefers missing a file to storing a credential. Errors: `cursor_invalid`, `path_unsafe`,
`provider_unavailable`, `invalid_options` on the receipt; logs carry only error names. No credentials, no network.

## Integration wiring

`startBrainProjectService` calls `bootstrapBrainMatrixDatabase` after github (`BRAIN_BOOTSTRAP_ORDER`) and adds the
three handlers to the sources service: notes with `createBrainMatrixNotesReader(appDb)` (null without an app
database), files with the owner `homePath`, chats with the owner `ChatRepository` (null without one). Nothing else
changes; no environment variables.

## Failure modes

A crash between pages resumes from the stored cursor; a page and its cursor commit together. A missing root reads as
empty (its documents are swept); a root behind a symlink, a missing home or a home that is a file fails the run with
`path_unsafe`. A file that changes during a read is read at the size seen at open. A notes table that does not exist
reads as no notes; other database errors end the run with `provider_unavailable`. A stopped run (abort) ends its page
at the last finished item.

## Resource management

| Limit | Value | Enforced in |
| --- | --- | --- |
| notes per pass / per page / content read | 5,000 / 100 / 70,000 characters | `notes.ts`, SQL `left()` |
| files: entries per page / per directory / directory entries read per page (skipped ones too) / bytes read per page (every outcome) / depth / path | 5,000 / 5,000 / 65,000 / 16 MiB / 12 / 512 bytes | `files-walk.ts`, `files.ts` |
| folder options: directory entries read | 5,000 | `files.ts` |
| chats: messages read per page / per day / parts per day / part bytes / message characters | 4,200 / 2,000 / 8 / 60,000 / 8,000 | `chat-render.ts` |
| sweep documents per page; options per page | 100 (or `maxDeletions`); 100 | `shared.ts`, handlers |
| config bytes; cursor length | 8 KiB (zod and SQL CHECK); under 2,048 characters | `config.ts`, `database.ts` |

In-memory sets live for one page only (note ids up to 5,000, chat existence up to 50). No timers, files or caches.
No data leaves the gateway.

## Invariants

- **Source of truth**: Notes rows, files under the roots and committed chat messages; brain documents are derived.
- **Lock/transaction scope**: config writes in one transaction under `brain-matrix:<scopeId>`; document writes only
  through the runner's `applySyncBatch` with the cursor compare-and-set.
- **Acceptable orphan states**: documents of removed items stay live until the sweep of the current pass reaches
  them; a tombstoned source keeps its config row until `eraseScope`.
- **Auth source of truth**: the request principal and the project scope; chats only through owner-scoped reads.
- **Deferred scope**: see Deferred.

## Integration test checkpoint

`pnpm exec vitest run tests/gateway/brain-source-matrix-*.test.ts` (PGlite store and app database, temporary homes,
an in-memory chat reader, injected file system faults). Manual (dev Docker stack, after spec 560 lands): connect
`matrix_files` with `{"roots":["projects/matrix-os/specs"]}` and sync until `caughtUp`; add a note tagged `brain`
and connect `matrix_notes` with `{"folders":["brain"]}`; opt one chat in; delete the note and sync again to see it
tombstoned.

## Code review checklist

Roots and every walked entry stay inside the real home without following a symlink; chats are read only for
configured ids through owner-scoped calls; every list, loop and set is bounded; no `catch {`; no route, timer or new
dependency.

## Delivery and evidence

- [ ] One PR under 2,900 additions, checks green, Invariants and the OS-view matrix (N/A) in the body.
- [ ] Site docs PR: Matrix sources, their configs and what each one stores.

## Deferred

Scheduled sync, organization scopes, `path` refs for files inside the project checkout, attachments and images,
Notes rich text and note handles, per-chat incremental reads (each pass re-reads opted-in chats), and a notes
`folders` field renamed to `tags` in the contract.
