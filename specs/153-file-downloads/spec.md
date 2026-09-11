# OM-243: Single-file downloads

## Baseline and scope

Baseline: main `9304931b82f7794815a2529e9f04d8b12fe2a3c1`.
Electron Desktop Files has uploads and previews but no download action. Add Download
for individual files, including binary/unsupported previews, from the preview and
list/grid context menus. Do not add or change structural file-management actions.

Downloads use authenticated `GET /api/files/media?path=...&download=true` with
backpressure instead of the buffered blob endpoint. There is no product file-size cap. Native transfers use inactivity limits rather
than a total deadline and can resume after an infrastructure connection reset. Upload/blob limits remain separate.
Folder/batch downloads are excluded. Gateway attachment/HEAD support, platform identity-length preservation, and the
edge header-timeout change must ship with the client changes.

## Data flow and authority

Electron Files -> validated IPC (path, request id, runtime/auth generation) ->
trusted main-process save dialog -> authenticated selected-runtime GET -> bounded
stream into an exclusive same-directory temporary file -> atomic local publication.
The renderer never receives credentials or arbitrary local destination paths.
Existing destinations require the native save dialog's overwrite confirmation;
changes to a destination observed during transfer are rejected. New destinations
are claimed exclusively, so a newly appeared file cannot be overwritten.

Web Desktop, Web Canvas, and Web Mobile share the web Files component. They get
the same single-file eligibility and safe outcome copy. An authenticated HEAD
preflight checks availability; a same-origin attachment URL then lets the browser
download manager stream to disk without a page Blob or full-file buffer. Browser
settings control the local save location, progress, cancellation, and completion.
The UI reports browser handoff rather than claiming a completed disk write.
Native Mobile is not modified by this desktop/web Files increment.

## Boundaries and limits

| Boundary | Authentication / validation | Limits |
| --- | --- | --- |
| runtime:download-file IPC | existing trusted preload; strict owner-relative path, UUID, runtime/auth snapshot | one native operation, 5-minute dialog lifetime |
| runtime:cancel-file-download IPC | strict UUID matching active request | no history or unbounded registry |
| GET/HEAD /api/files/media?download=true | existing Gateway owner authorization and path denial; captured trusted token/runtime for Electron, existing cookie session for web | eight open downloads per owner Gateway; 64 KiB reads; 60-second inactivity cleanup; no file-size cap |
| Platform/edge proxy | existing session/runtime routing and response streaming | 30-second edge header wait; healthy attachment bodies keep streaming |
| Native save | local path comes only from native dialog; regular-file checks, overwrite confirmation | one transfer; 30-second headers, 60-second idle reads; private temp file, explicit finally cleanup |
| Web download | current same-origin gateway/session and explicit VM prefix; preflight redirects rejected | one HEAD preflight per Files provider, 30 seconds; body/cancel/retry owned by browser |

The download source is opened once and streamed from that descriptor. Gateway
attachment responses include sanitized UTF-8 Content-Disposition, no-sniff, no-store,
exact length, and an entity tag. Range requests support browser resumption; a stale
If-Range validator falls back to a complete response. Source truncation or an in-place modification aborts the
stream before the final chunk; idle timeout and client disconnect release the descriptor and capacity.
Electron resumes interrupted HTTP bodies with the exact written offset and original
strong entity tag. A changed source fails safely; no-progress retries are bounded
to three attempts. Local disk failures and explicit cancellation are never retried.
The configured Cloud Run single-request timeout remains 300 seconds: Electron can
span those requests through validated resumption; browser recovery is controlled
by its download manager. No deployment setting is silently increased.

Runtime/auth changes and shutdown abort native operations and drain partial-file
cleanup. On web, scope changes cancel preflight; after handoff the browser owns the
transfer, so closing Files or signing out does not revoke an admitted download. Cancellation before publication never reports completion; cancellation after a
completed save cannot undo that save. Raw provider, path, filesystem,
and network errors are logged only in trusted code; client outcomes are allowlisted.
Temporary files use exclusive, private same-directory names and explicit finally
cleanup; an uncatchable OS/process crash may leave a private partial file. No sweep
of arbitrary user-chosen destination directories is introduced.

## Delivery and validation

1. Failing native download and UI wiring tests, including large binary bytes, inactivity,
   cancellation, overwrite protection, stale runtime/auth, and disk/write failures.
2. Implement bounded trusted save/transfer and shared download outcome semantics.
3. Wire Electron and applicable web Files actions without changing management flows.
4. Run focused tests, typecheck, pattern scan, and production Electron/Web builds.
5. Validate built Electron and browser download manager with a 64 MiB file served
   by the real local Gateway handler through production platform response handling
   and compare SHA-256. Force an HTTP disconnect to verify native resumption. Verify source backpressure,
   cancellation, truncated input, HEAD/Range, and edge streaming beyond 30 seconds.
   Provide runnable Human Review; local fixture evidence is not live VPS evidence.
6. Open implementation PR and a separate documentation PR in
   `FinnaAI/matrix-os-site` under `content/docs/`; stop for explicit Human Review.
