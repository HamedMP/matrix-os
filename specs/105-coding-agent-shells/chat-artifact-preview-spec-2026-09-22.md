# Chat artifacts and unified file preview — proposed design

Status: planning only; no product changes, runtime proof, release, or deployment.
Baseline: `096151518c979928433f590a969a17f90cfc4b14` (2026-09-22).
User request: show agent-generated images directly in Chat, open file links in File Preview, consider other formats, and reference Codex and T3.

## Product outcome

An assistant can deliver an image, PDF, document, spreadsheet, audio clip, or video as an inspectable file. Images appear in the conversation; clicking an image or file opens the existing File Preview surface without losing the conversation. Download is a separate explicit action. Reloading or reopening the conversation preserves delivered artifacts. A missing or unsupported resource shows an explanatory card, never a blank panel or bare broken-image icon.

The supplied screenshots establish the visible symptoms: a textual success claim with no image, a file link that opens a panel without a usable preview, and later a broken Markdown image. They do not prove which provider event or filesystem path was returned. Capture that original event/path during implementation before attributing this exact incident to one cause.

## Verified Matrix baseline

- `desktop/src/renderer/src/components/conversation/transcript.tsx`: assistant response renders Markdown; it does not render the structured attachment list used by `user-message.tsx`.
- `desktop/src/renderer/src/components/conversation/message.tsx`: Markdown file links are intercepted, but there is no authenticated local-file `img` renderer.
- `desktop/src/renderer/src/features/chat/CanonicalChatWorkspace.tsx`: file links already call Chat file navigation. Do not add a second competing sidebar.
- `desktop/src/renderer/src/features/work/work-files-scope.ts`: current link resolution uses the active/latest run's worktree. Historical messages need their originating run instead.
- `desktop/src/renderer/src/features/panels/InspectorFilesPanel.tsx`: home files use FilePreview; project files use text-only `runtime:get-file-content` and Monaco.
- `desktop/src/renderer/src/features/files/FilePreviewPane.tsx`: image, Markdown, and text previews; no PDF renderer.
- `shell/src/components/chat/ChatFilePanel.tsx`: separate home-only blob loader with image/text handling and an 8 MiB cap. This differs from Electron's 10 MiB image cap.
- `shell/src/components/preview-window/PreviewTab.tsx`: PDF is a placeholder with an external-open link.
- `packages/gateway/src/coding-agents/codex-app-server-runner.mjs`: lifecycle allowlist omits image-generation items; unknown lifecycle types are acknowledged without emitting a displayable artifact. Exact installed-provider shapes still require a spike.
- `packages/gateway/src/file-blob-routes.ts`: `/blob` buffers up to 10 MiB; `/media` already streams and supports Range. Do not raise the blob cap to support video/PDF.
- `specs/153-file-downloads/spec.md`: existing authenticated streaming downloads, cancellation, resumption and owner-data constraints are the reuse baseline.

## Interaction and format coverage

Images use bounded, aspect-ratio-preserving thumbnails in Chat; click opens full preview. Multiple images form a compact group in message order. File cards show filename, type, size when known, Preview and Download. PDF/audio/video/Office files default to cards rather than expanding every large asset inline. Keyboard activation, Escape, focus restoration, alt text, loading and retry are required. Streaming incomplete Markdown must not repeatedly request malformed paths. A finalized bad reference becomes an error card with safe copy.

| Format | Chat | File Preview | Delivery |
| --- | --- | --- | --- |
| PNG/JPEG/WebP/GIF/AVIF | Inline thumbnail, animated GIF subject to reduced-motion handling | Fit, zoom, pan, original dimensions, download | Core |
| SVG | Safe image thumbnail | Image mode with external resource/script execution blocked; source toggle | Core |
| PDF | File card | PDF.js pages, page count, pagination, zoom, text selection, download; encrypted/invalid files have explicit states | Core |
| TXT/code/JSON/YAML/XML/log | File card or existing text response | Read-only code/text with bounded truncation; JSON stays source by default | Core |
| Markdown | File card | Sanitized render/source toggle; nested local links and images resolve relative to the Markdown file's directory in the same scope | Core |
| CSV/TSV | File card | Bounded virtualized table plus source; quoted cells/newlines; formula strings never executed | Core |
| MP3/WAV/OGG/M4A; MP4/WebM/MOV | File card | Explicit-play controls, seeking, mute/volume, no autoplay; actual codec support decides playback, fallback download | Core |
| HTML | File card | Source by default; explicit static preview in a sandbox with no scripts, network, forms, popups or top navigation | Core |
| DOCX/ODT/RTF; PPTX/ODP; XLSX/ODS | File card | Owner-runtime conversion to paginated PDF for documents/slides; read-only sheet data for spreadsheets; label fidelity limits and retain original download | Document increment |
| HEIC/TIFF/BMP and unsupported image codecs | File card until conversion | Owner-runtime raster conversion under resource limits | Document increment |
| ZIP/TAR and other archives | File card | Metadata and download; no auto-extraction | Core fallback |
| Legacy Office, executables, fonts, 3D/CAD, unknown binaries | File card | Metadata, explicit unsupported state, download/open externally where platform supports it | Core fallback |

“All formats considered” means every file has defined behavior; it does not imply universal native rendering. Full Office editing, macros/formula recalculation, arbitrary executable HTML/apps, automatic archive extraction and interactive 3D are outside this proposal. Office conversion is a separate deliverable in the same plan, not silently counted as implemented by the core release.

## Architecture and interfaces

One shared resource contract and preview policy, with thin platform viewers. Do not copy T3's server, database, RPC, PTY, or persistence architecture.

```ts
type FileResourceRef =
  | { kind: 'home'; path: string }
  | { kind: 'project'; projectId: string; worktreeId?: string; path: string }
  | { kind: 'artifact'; chatId: string; artifactId: string };
type PreviewKind = 'image' | 'pdf' | 'text' | 'markdown' | 'table'
  | 'audio' | 'video' | 'html' | 'converted' | 'unsupported';
type FilePreviewDescriptor = {
  resource: FileResourceRef; name: string; mimeType: string; sizeBytes: number;
  kind: PreviewKind; version: string; canDownload: boolean;
};
```

Refs contain no credentials, object URLs, runtime-local absolute paths or arbitrary remote fetch URLs. The selected runtime and authorization generation remain request context, not a client-granted privilege. Validate schemas at HTTP/IPC boundaries. Gateway derives authorized roots and validates real paths/symlinks on access; display labels and MIME supplied by an agent are untrusted.

### Messages and durable artifacts

Reuse canonical `attachment_reference` parts for delivered artifacts, with `attachmentId` resolving to a Gateway artifact record. Keep image/file kinds; preview kind is derived metadata, not a provider-specific message type. Keep existing user attachment behavior and input-upload size bounds compatible. Artifact size metadata is fetched from the output descriptor; do not force large output artifacts through the user-upload size validator. Do not increase the 8-attachment / 64-part message bounds globally: split large deliveries into bounded assistant artifact messages. Preserve text-only wire fallbacks for clients that cannot negotiate the enriched artifact descriptor.

A new owner-controlled Postgres artifact record binds ID, owner, Chat/message/run IDs, provider item identity, original execution root, MIME/size/hash and stored owner-relative path. Persist immutable delivered bytes in owner storage under `files/chat-artifacts/<chat-id>/<artifact-id>/<safe-name>`. A generated artifact is a delivery snapshot; an ordinary Markdown link is a live reference to its original home/project/worktree, explicitly allowed to become missing after deletion. Never resolve an old turn against the most recent run's root.

Only authoritative provider file/image output events or an explicit validated artifact delivery operation create snapshots. Do not scrape arbitrary tool stdout for paths or read every file mentioned by the assistant. Handle text Markdown images/file links independently so all providers benefit even without structured output support. Provider-specific `sandbox:` or temporary absolute paths must map through proven provider-run context; unknown mappings show unavailable, never guess the host path.

Filesystem/DB consistency: stream to exclusive private staging file, verify bounds/hash, atomically publish, then transactionally insert artifact/message/event/outbox records with unique provider-event identity. Only advertise ready after both bytes and transaction exist. Failed DB persistence may leave an unreferenced file; a recurring symlink-safe sweep removes staging/unreferenced files older than 24 hours after a DB reference check. Retries reuse the event identity and do not duplicate cards. Referenced bytes persist until an explicit owner data lifecycle operation; never apply upload-temp cleanup to them. If snapshot admission fails, retain a safe failure card, not a fabricated successful artifact.

### Unified reads and navigation

Add `GET /api/file-previews/metadata` and `GET|HEAD /api/file-previews/content` with strict discriminated query schemas equivalent to FileResourceRef; `download=true` selects Content-Disposition attachment. Reuse the existing file authorization/root-resolution and download-stream primitives. Existing file routes remain compatible. Project and worktree binary reads use the same authorized project resolver as `coding-agents/file-read.ts`, not a general host-filesystem endpoint.

Markdown link/image normalization happens once in shared code; the server repeats authority checks. Resolve relative paths against the originating message execution root, and nested Markdown against its containing directory. Handle spaces, Unicode, URL encoding, line anchors, explicit home aliases and file URLs without double decoding. HTTP(S) links remain web links. Remote images get a labeled external-image placeholder and explicit external-open action initially; do not build an unrestricted image proxy or send credentials to external origins. Bounded provider data-URI image output is ingested into an artifact instead of persisting base64 in transcript JSON.

On Electron, use the existing trusted runtime HTTP/IPC transport and captured runtime/auth scope; do not expose bearer tokens to DOM URLs. On Web, use existing authenticated same-origin selected-runtime routing. PDF.js uses authenticated range requests; media uses authenticated same-origin streams or a narrowly scoped trusted Electron protocol bridge that forwards Range. Do not buffer complete movies in renderer memory. No personal-browser cookies or long-lived tokens in query strings. Native Mobile uses authenticated requests and a local private cache for supported platform preview; delete cache on scope change/logout and enforce its size cap.

A shared `FilePreviewHost` routes descriptors to lazy viewers. Electron Files, Chat inspector, project Files, Web Chat and Web Preview consume it. Native Mobile shares contract/policy/copy and uses native adapters. Layout changes between sidebar and full-screen do not change semantics. Chat link clicking means Preview; Download always downloads. A path outside an admitted root shows unavailable; opening a pane alone is not success.

### Authorization matrix

| Boundary | Authority | Denial / constraints |
| --- | --- | --- |
| Preview metadata/content for home | Current runtime principal + existing owner/file policy | Reject traversal, symlink escape, sensitive paths; generic errors |
| Project/worktree preview | Current principal + project access + canonical worktree binding | No cross-project/root substitution; old deleted worktree is missing |
| Artifact metadata/content | Current Chat access AND underlying artifact/owner permission | Shared Chat membership alone never grants arbitrary owner-file access |
| Shared artifact projection | Existing collaboration policy explicitly permits the delivered resource | Otherwise withhold bytes/path; show permission state |
| Artifact ingest | Internal authenticated run event; server-derived owner/run/root | No client-submitted ownership, no arbitrary absolute-file ingest |
| Conversion request | Same read permission + runtime quota | POST bodyLimit 16 KiB; current principal rechecked before publishing derived bytes |
| Download | Same read authorization; existing trusted save/browser download flow | Never execute or auto-open downloaded content |

## Limits and isolation (proposed defaults)

- Inline thumbnail: 1024 px longest edge, target <= 1 MiB; 3 concurrent loads; original images <= 40 megapixels for in-process decode, larger files show download/conversion fallback.
- Text: 1 MiB / 100,000 visible characters; table: first 10,000 rows, 200 columns, 5 MiB parse budget. Display truncation and keep original download.
- PDF: lazy page rendering; <= 3 live page canvases; 50 MiB admitted preview file, range reads; larger original remains downloadable. Password-protected PDFs show an explicit unsupported-password state in core.
- Binary media: stream in 64 KiB chunks with Range, abort on disconnect, 30-second headers and 60-second idle timeout; download has no new file-size cap.
- Renderer Blob cache: 32 MiB LRU, object URLs revoked on eviction/unmount/scope change. No unbounded Map/Set, pending request or event registry.
- Artifact snapshot: <= 256 MiB per artifact, <= 8 artifacts per emitted message; larger deliveries remain live downloadable references with an explicit non-snapshotted state.
- Conversion: 50 MiB input, 100 MiB output, 60-second wall time, 512 MiB memory, one worker per runtime, queue <= 8; no network, macros, external links or embedded-object execution. Cap expanded archive bytes to 200 MiB and 10,000 entries before Office parsing; kill worker and clean temp files on timeout/cancel/shutdown.
- Derived cache: owner scoped, hash+converter-version keyed, 512 MiB LRU disk budget, recurring 24-hour unused eviction. Original owner files are never overwritten.
- SVG/HTML: never inject raw markup into the shell DOM. Sanitize active/external references, render isolated output, and test CSP behavior in packaged Electron and Web.

Defaults are product limits, not measured performance claims; implementation spikes may propose reviewed changes before shipping. API headers include no-sniff and private/no-store; safe client error codes distinguish missing, forbidden, too large, unsupported, invalid and retryable without leaking paths/provider exceptions.

## Surfaces, delivery and acceptance

Core release covers Web Desktop, Web Canvas and Electron Desktop together. Web Mobile uses the same Web viewers in a full-screen panel. Native Mobile receives image/PDF/text/table/media viewing via authenticated native adapters; static HTML source is available, and sandboxed HTML visual preview may explicitly remain desktop/web-only. No Expo Go acceptance. Codec/device limitations are visible download fallbacks, not unexplained blanks. Document conversion is enabled across these surfaces only after its runtime service is actually present.

Required real validation: generate an image with the configured Codex provider; capture the sanitized actual output event; see the image inline; click to a decoded image in preview; download and compare bytes/hash; reload and cold-start; switch Chat/runtime/worktree and confirm no stale image leakage. Repeat representative Markdown file delivery with another configured provider. Test both home and project/worktree sources and a past message after a new run chooses a different worktree.

Fixtures cover each format and denial state, but do not replace live selected-VPS checks, packaged Electron, Web Desktop/Web Canvas/Web Mobile and Native Mobile device checks. Prepare an exact-head runnable Human Review environment and a short flow. Merge, release publication and VPS rollout remain separate later actions. Public product documentation belongs in `FinnaAI/matrix-os-site`, not a recreated local `www/` tree.

References: [research report](chat-artifact-preview-references-2026-09-22.md). Implementation: [task plan](chat-artifact-preview-plan-2026-09-22.md).
