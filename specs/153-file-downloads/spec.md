# OM-243: Single-file downloads

## Baseline and scope

Baseline: main `9304931b82f7794815a2529e9f04d8b12fe2a3c1`.
Electron Desktop Files has uploads and previews but no download action. Add Download
for individual files, including binary/unsupported previews, from the preview and
list/grid context menus. Do not add or change structural file-management actions.

The existing authenticated `GET /api/files/blob?path=...` contract limits reads to
10 MiB. This first increment keeps that limit, exposes a clear limit error, and
adds no Gateway API or deployment dependency. Folder/batch downloads are excluded.

## Data flow and authority

Electron Files -> validated IPC (path, request id, runtime/auth generation) ->
trusted main-process save dialog -> authenticated selected-runtime GET -> bounded
stream into an exclusive same-directory temporary file -> atomic local publication.
The renderer never receives credentials or arbitrary local destination paths.
Existing destinations require the native save dialog's overwrite confirmation;
changes to a destination observed during transfer are rejected. New destinations
are claimed exclusively, so a newly appeared file cannot be overwritten.

Web Desktop, Web Canvas, and Web Mobile share the web Files component. They get
the same single-file eligibility and safe outcome copy with a bounded authenticated
blob download. Browser settings control the local save location and completion;
the UI reports browser handoff rather than claiming a completed disk write.
Native Mobile is not modified by this desktop/web Files increment.

## Boundaries and limits

| Boundary | Authentication / validation | Limits |
| --- | --- | --- |
| runtime:download-file IPC | existing trusted preload; strict owner-relative path, UUID, runtime/auth snapshot | one native operation, 5-minute dialog lifetime |
| runtime:cancel-file-download IPC | strict UUID matching active request | no history or unbounded registry |
| GET /api/files/blob | existing Gateway owner authorization; captured trusted token/runtime; redirects rejected | 10 MiB, 30-second transfer, byte-count validation |
| Native save | local path comes only from native dialog; regular-file checks, overwrite confirmation | private exclusive temp file, explicit finally cleanup |
| Web download | current same-origin gateway/session and explicit VM prefix; redirects rejected | one operation per Files provider, 10 MiB, 30 seconds; object URL TTL cleanup |

Runtime/auth changes and shutdown abort native operations and drain partial-file
cleanup. Cancellation before publication never reports completion; cancellation after a
completed save cannot undo that save. Raw provider, path, filesystem,
and network errors are logged only in trusted code; client outcomes are allowlisted.
Temporary files use exclusive, private same-directory names and explicit finally
cleanup; an uncatchable OS/process crash may leave a private partial file. No sweep
of arbitrary user-chosen destination directories is introduced.

## Delivery and validation

1. Failing native download and UI wiring tests, including binary bytes, limits,
   cancellation, overwrite protection, stale runtime/auth, and disk/write failures.
2. Implement bounded trusted save/transfer and shared download outcome semantics.
3. Wire Electron and applicable web Files actions without changing management flows.
4. Run focused tests, typecheck, pattern scan, and production Electron/Web builds.
5. Validate exact built Electron with a real remote-to-local binary download and
   byte comparison; provide runnable Human Review steps and evidence.
6. Open implementation PR and a separate documentation PR in
   `FinnaAI/matrix-os-site` under `content/docs/`; stop for explicit Human Review.
