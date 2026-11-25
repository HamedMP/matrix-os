# App file bridge and open-with

For the gateway and shell implementers of [spec 2710](spec.md). The contract is code:
`packages/contracts/src/app-files.ts` (`@matrix-os/contracts/app-files`) and
`packages/contracts/src/office-open-with.ts` (`@matrix-os/contracts/office-open-with`).
Import schemas, limits and messages from there; do not copy them. Apps see the result as
`window.MatrixOS.files`, typed in `home/apps/_shared/matrix-os.d.ts`.

## Route and envelope

`POST /api/bridge/files` (`APP_FILES_BRIDGE_PATH`), JSON in and out, behind the gateway auth.
Body: `AppFileRequestSchema` = `{ app, input }`. The shell binds `app` from the trusted app
identity and drops any `app` the iframe sent, as `prepareAppCapabilityRequest` does. `input`
is `AppFileInputSchema`, a strict union on `kind`:

| `kind` | Input | Reply schema | Reply |
| --- | --- | --- | --- |
| `files.list` | `dir` (`""` = home root), `limit` 1-500, default 500 | `AppFileListReplySchema` | `{ entries: [{ name, path, kind: "file" \| "dir", size, modifiedAt }], truncated }` |
| `files.stat` | `path` | `AppFileStatReplySchema` | `{ path, size, modifiedAt, version }` |
| `files.read` | `path` | `AppFileReadReplySchema` | `{ path, contentBase64, size, version, mimeType }` |
| `files.write` | `path`, `contentBase64`, `ifVersion: string \| null`, `createParents?` | `AppFileWriteReplySchema` | `{ path, version, size, modifiedAt }` |
| `files.mkdir` | `path` | `AppFileMkdirReplySchema` | `{ path }` |

Paths (`AppFilePathSchema`) are home-relative with forward slashes: 1-4096 characters, no NUL,
no backslash, no leading or trailing slash, no empty, `.` or `..` segment. This is syntax only.
The gateway resolves reads with `resolveExistingFileApiPath` and writes and mkdir with
`resolveWritableFileApiPath`, and refuses `isProtectedHomeSubpath` targets. `modifiedAt` is
`new Date(mtimeMs).toISOString()`. Listings put directories first, then sort by name, and omit
symlinks and protected entries. `stat`, `read` and `write` accept regular files only.

## Gateway checks, in order

1. Owner check and rate limit, as in `app-capabilities/routes.ts` (a busy route replies
   `unavailable`).
2. `bodyLimit({ maxSize: MAX_APP_FILE_REQUEST_BYTES })`, then `AppFileRequestSchema`.
3. Access: the manifest of `app` is `listingTrust: "first_party"`, not imported, and its
   `permissions` include `APP_FILES_PERMISSION` (`"files"`). Otherwise `forbidden`.
4. Path resolution, then the operation.

## Limits

| Constant | Value | Use |
| --- | --- | --- |
| `APP_FILE_MAX_BYTES` | 10 MiB | Decoded file size, read and write |
| `MAX_APP_FILE_REQUEST_BYTES` | base64 of 10 MiB + 64 KiB | Route `bodyLimit`; shell cap for a write |
| `MAX_APP_FILE_REPLY_BYTES` | same | Shell cap for a read reply |
| `MAX_APP_FILE_LIST_REPLY_BYTES` | 8 MiB | List reply; stop adding entries and set `truncated` first |
| `appFileRequestBytes(kind)` / `appFileReplyBytes(kind)` | per kind | Other kinds stay at 64 KiB in, 256 KiB out |
| `APP_FILE_TIMEOUT_MS` | 60 s | Shell and Electron request budget |

A read of a file above 10 MiB is `too_large`; `stat` still reports its true size.

## Errors

Every failure is `appFileErrorBody(code)`: `{ error: { code, message } }` with the fixed message
from `APP_FILE_ERROR_MESSAGES` and the status from `APP_FILE_ERROR_STATUS`. Log the cause
server-side; never return a path, an errno or a Zod issue.

| Code | Status | When |
| --- | --- | --- |
| `invalid_request` | 400 | Body fails the schema; target is a directory where a file is needed, or the reverse |
| `forbidden` | 403 | No `files` permission or not first-party; protected or unwritable path; symlink |
| `not_found` | 404 | Path does not resolve (also for denied subtrees, so their existence is not revealed); missing parent without `createParents` |
| `version_conflict` | 409 | `ifVersion` does not match; `ifVersion: null` and the file exists |
| `too_large` | 413 | File or body above the cap |
| `unavailable` | 503 | Owner file mutation busy, rate limit, I/O failure, anything unexpected |

## Version and write semantics

`version` is `appFileVersion(size, mtimeNs)` from `stat(path, { bigint: true })`. Only the gateway
computes it; apps and the shell treat it as an opaque string. Two states with equal size and
equal mtime are indistinguishable, so the compare must be inside the write's critical section:

1. Run write and mkdir inside `withOwnerFileMutation` (busy maps to `unavailable`).
2. Inside it, stat the target and compare with `ifVersion`. With `null`, the file must be absent.
3. Write a temp file in the target directory, then `rename` over the target (keep the existing
   file mode). For `ifVersion: null`, publish with `link(tmp, target)` so a file created in the
   meantime gives `EEXIST` and `version_conflict`, then unlink the temp file.
4. Always remove the temp file on failure. Reply with the version of the new file.

`files.mkdir` is recursive and idempotent. A write never creates parents unless `createParents`.

## Shell wiring (Web Desktop and Web Canvas)

- `app-viewer-bridge-policy.ts`: add `/api/bridge/files` to the exact-match list.
- `app-capability-request.ts`: bind `{ app, input }` with `AppFileInputSchema`; size the body with
  `appFileRequestBytes(input.kind)` and the reply with `appFileReplyBytes(input.kind)`; use
  `APP_FILE_TIMEOUT_MS`.
- Error bodies: `handleBridgeFetch` drops non-2xx bodies. For this URL, pass the body on when it
  parses as `AppFileErrorBodySchema`; otherwise use `appFileErrorCodeForStatus(status)`.
- `os-bridge.ts`: add `files` to the injected object and raise the `parentFetch` frame limit for
  this URL. The script encodes and decodes base64 itself. Every method rejects with an `Error`
  whose `name` is `"BridgeFileError"`, with `code` and the fixed message. `createAppFilesClient`
  in the contract is the reference behaviour and can be used directly outside the iframe.
- `tests/contracts/app-files.test.ts` compares the top-level and `db` members of the injected
  object with the d.ts. A member added to one must be added to the other; `files` is expected.

## Open-with

1. Files calls `openWithHandoff(path, { now: Date.now(), nonce: crypto.randomUUID() })`. `null`
   means no default app (`defaultAppForFile`: `.docx` to `docs`; `.xlsx`, `.csv`, `.tsv` to
   `sheets`), so Files falls back to Preview.
2. Files writes the request to the target app's key-value store: `POST /api/bridge/data`
   `{ action: "write", app, key: "open-request", value: encodeBridgeStoredValue(request) }`.
   The encoding is what `readData` decodes.
3. Files launches or focuses the app only after the write succeeds.
4. On load the app calls `files.openRequest()`. A running app gets the request through
   `files.onOpenRequest(cb)`, driven by the `data:change` event for that key.
5. Delivery follows `createOpenRequestInbox`: validate with `parseOpenRequest` (drop requests
   older than 10 minutes) and deliver each `nonce` once. The app never writes `open-request`:
   it records the handled nonce under `open-request-ack`, so Files stays the only writer of the
   request key and a request stored during a read cannot be erased. Reopening the app later
   therefore does not reopen the file; an app that wants to restore its last document stores
   that itself. The injected script inlines the same steps.

The request carries a path, not access: the app still reads through `files.read`.

## Electron Desktop parity

- Expose `files` on `__matrixNativeBridge` with `createAppFilesClient((input) =>
  ipcRenderer.invoke(APP_FILES_CHANNEL, input))`. The main process binds the app identity,
  applies the same byte caps and timeout, posts to the gateway route and returns the JSON body,
  including error bodies.
- `contextBridge` copies thrown errors and loses `name` and `code`. Return a result value from
  the preload and throw the `BridgeFileError` shape in the main-world wrapper.
- Electron has no `readData`, `writeData` or `onDataChange`. Either add them, or implement
  `openRequest` and `onOpenRequest` over IPC with the same `OpenRequest` shape and the same
  deliver-once rule. Native Files then calls the same `openWithHandoff`.
- Until this lands, `window.MatrixOS.files` is undefined in Electron Desktop and Docs and Sheets
  cannot open owner files there.

## Known limits of the POC

- The key-value store is per owner, not per device. An app open on two surfaces may both
  receive one request.
- A same-size rewrite within one mtime tick is not detected by `version`.
