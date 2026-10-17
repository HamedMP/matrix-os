# Company Brain Matrix sources

The owner's own Matrix content as Company Brain sources: Notes (`matrix_notes`), files under chosen home folders
(`matrix_files`) and the chats the owner opts in (`matrix_chat`). Spec: `specs/559-company-brain-matrix-sources/spec.md`.

## Scope

- Owns `brain_matrix_sources` (one config row per source) and three `BrainSourceKindHandler`s with their adapters.
- Out of scope: the `/sources` routes, the sync runner and the handler registry (sources/core), scheduled sync,
  organization scopes, attachments and images, and Notes rich text (`content_json`); the markdown `content` is used.

## Source Of Truth

- Notes: the owner app database table `"notes"."notes"` (read with fixed SQL through `AppDb.raw`).
- Files: the files themselves under the configured home-relative roots.
- Chats: `ChatRepository` (`get`, `getMessages`, `list`), owner-scoped, committed messages only.
- The brain store holds derived documents only; `brain_matrix_sources` holds each source's config.

## Public API

`index.ts`: `bootstrapBrainMatrixDatabase`, `createBrainMatrixNotesHandler({ kysely, notes })`,
`createBrainMatrixNotesReader(appDb)`, `createBrainMatrixFilesHandler({ kysely, homePath })`,
`createBrainMatrixChatHandler({ kysely, chats })`, the reader seams and `BRAIN_MATRIX_LIMITS`.

## Documents

| Kind | Provenance | Id tuple tail | Refs |
| --- | --- | --- | --- |
| `matrix_notes` | `matrix_note` | note id | `label` per tag (at most 20) |
| `matrix_files` | `matrix_file` | home-relative path | `file` |
| `matrix_chat` | `matrix_chat` | chat id, UTC day, part | `chat`, `participant` (`matrix:<user id>`, at most 50) |

Ids are `sha256(JSON.stringify([version, externalRef, ...tail]))`, never of content. Permalinks are empty.

## Auth And Trust Boundaries

- The sources service resolves the project and scope from the request principal; handlers never authorize.
- Notes and files belong to the gateway's home owner. Chats are read only for ids in `chatIds`, only through
  `ChatRepository.get` / `getMessages` with the owner `{ type: "personal", ownerId }`; a chat that is not the owner's
  reads as missing and its documents are swept.
- Roots: home-relative, no `..`, no hidden segment, never `system`, `agents` or anything holding
  `data/browser-profiles`, never nested in each other. At run time a root must resolve to exactly
  `<real home>/<root>`; a symlink on the way or a root that is a file is `path_unsafe`.
- The walk never follows a symlink and skips hidden names, `node_modules` and names with control characters. A file
  is opened with `O_NOFOLLOW` and must be the same regular file at the moment it is read, with its parent still
  inside the root (its folder resolves to itself before and the path names the open file after the open).
- Secret-like names (`isSecretLikeName` in `config.ts`: words such as `secrets`, `credentials`, `token`, `api-key`,
  `service-account` between `.`, `_`, `-` or the ends, and `.pem`, `.key`, `.p12`, `.pfx`, `.keystore`, `.jks`) are
  never read: such folders are not walked, such files count as skipped, a root may not hold one, and the sweep
  tombstones earlier documents under them. A folder over 5,000 entries is left out whole (`items_truncated`), and the
  sweep tombstones documents under it too. Files whose text holds a private key, a cloud or chat token or a service
  account key (`isSecretLikeText`) are skipped the same way. Both add the run notice `secret_skipped`. This keeps
  credentials out of brain search and the agent read tools.
- Bounds: a files page reads at most 16 MiB of file content (binary files count; a file that does not fit waits for
  the next page); a notes page keeps within `maxRefs` (limits under 20 refs are `invalid_options`); the folder picker
  reads at most 5,000 directory entries and answers `source_config_invalid` for a `q` that is a symlink or a file.
- Errors: expected failures are result codes (`cursor_invalid`, `path_unsafe`, `provider_unavailable`,
  `invalid_options`); reader failures are logged by error name only. No paths, text or SQL in logs.

## Concurrency And Recovery

- Each run continues one full pass: a scan (upserts; unchanged content is a no-op in the store) and then a sweep over
  `listDocuments({ sourceId })` that tombstones documents whose item is gone or no longer selected. Only the end of
  the sweep is `caughtUp`; the cursor then starts the next pass.
- Cursors (`mn1:`, `mf1:`, `mc1:` + base64url JSON) record the exact position, so a crash or a stop at any page
  boundary resumes without loss; a cursor that does not parse is `cursor_invalid`. A chat cursor never points at
  the end of a chat, so a message added later to that chat's last day waits for the next pass instead of starting
  the day again.
- Config writes take `brain-matrix:<scopeId>`, never the core brain lock. The table goes with its source on
  `eraseScope` (FK cascade); a tombstoned source keeps its row until then.

## Tests

`pnpm exec vitest run tests/gateway/brain-source-matrix-*.test.ts` (PGlite store, a PGlite app database for notes,
temporary home folders for files, an in-memory chat reader; the loop in `helpers/brain-source-matrix-loop.ts`
applies pages the way the runner does).
