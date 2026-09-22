# Chat artifacts and unified file preview

Status: core implementation is in PR #1844 for ENG-4; focused automated checks pass. Exact-head Human Review, live provider proof, production builds, Greptile, merge, release and deployment are still pending. Office/image conversion remains ENG-5.
Baseline: `096151518c979928433f590a969a17f90cfc4b14` (2026-09-22).
User request: show agent-generated images directly in Chat, open file links in File Preview, consider other formats, and reference Codex and T3.

## Product outcome

An assistant can deliver a generated image or other bounded provider artifact as an inspectable file. Images appear in the conversation; clicking an image or file opens File Preview without losing the conversation. Reloading or reopening the conversation preserves delivered artifacts. A missing or unsupported resource shows an explanatory state instead of a blank panel or broken-image icon.

The supplied screenshots establish the visible symptoms: a textual success claim with no image, a file link that opens a panel without a usable preview, and later a broken Markdown image. They do not prove which provider event or filesystem path was returned. Capture that original event/path during implementation before attributing this exact incident to one cause.

## Implemented core

- `desktop/src/renderer/src/components/conversation/transcript.tsx`: assistant structured attachments render through the same bounded attachment UI used elsewhere in Chat.
- `desktop/src/renderer/src/components/conversation/message.tsx`: local Markdown images become File Preview actions instead of unauthenticated or broken `<img>` elements.
- `desktop/src/renderer/src/features/chat/CanonicalChatWorkspace.tsx`: file links already call Chat file navigation. Do not add a second competing sidebar.
- `desktop/src/renderer/src/features/work/work-files-scope.ts`: current link resolution uses the active/latest run's worktree. Historical messages need their originating run instead.
- `packages/ui/src/files/FilePreviewContent.tsx`: one renderer handles validated image, PDF, text/Markdown source, CSV/TSV, audio, video, sandboxed static HTML and unsupported states.
- Electron File Preview and Web Chat consume the shared descriptor/renderer. PDF uses Chromium's authenticated Blob viewer in this increment; advanced PDF.js navigation is not claimed.
- `packages/gateway/src/coding-agents/codex-app-server-runner.mjs`: completed resource-bearing Codex items become immutable owner files with bounded capture and content hashes; raw paths and base64 are not written to the visible transcript.
- Canonical Chat persists `assistant.attachment` into `attachment_reference` parts and `chat_attachments` in the same transaction, with idempotent replay repair.
- Native Mobile preserves assistant attachment references, shows authenticated generated-image thumbnails, and opens the existing File Preview route. Rich PDF/table/media rendering on Native Mobile remains a recorded platform limitation for this increment.
- `GET /api/file-previews/metadata` and `GET|HEAD /api/file-previews/content` provide authenticated, range-capable, no-sniff reads for home, project/worktree and artifact references.
- `specs/153-file-downloads/spec.md`: existing authenticated streaming downloads, cancellation, resumption and owner-data constraints are the reuse baseline.

## Interaction and format coverage

Images use bounded, aspect-ratio-preserving thumbnails in Chat; click opens full preview. Multiple images form a compact group in message order. File cards show filename, type, size when known, Preview and Download. PDF/audio/video/Office files default to cards rather than expanding every large asset inline. Keyboard activation, Escape, focus restoration, alt text, loading and retry are required. Streaming incomplete Markdown must not repeatedly request malformed paths. A finalized bad reference becomes an error card with safe copy.

| Format | Chat | File Preview | Delivery |
| --- | --- | --- | --- |
| PNG/JPEG/WebP/GIF/AVIF | Inline thumbnail | Fit in shared viewer; Electron keeps its existing image viewer behavior | Core in PR #1844 |
| SVG | File card | Explicit unsupported state until a dedicated sanitizer/isolated viewer blocks active and external references | Follow-up |
| PDF | File card | Authenticated Blob in Chromium's built-in PDF viewer; invalid files have explicit failure state | Core in PR #1844; advanced PDF controls deferred |
| TXT/code/JSON/YAML/XML/log | File card or existing text response | Read-only code/text with bounded truncation; JSON stays source by default | Core |
| Markdown | File card | Sanitized render/source toggle; nested local links and images resolve relative to the Markdown file's directory in the same scope | Core |
| CSV/TSV | File card | Bounded read-only table; quoted cells/newlines; formula strings never executed | Core in PR #1844 |
| MP3/WAV/OGG/M4A; MP4/WebM/MOV | File card | Explicit-play controls, seeking, mute/volume, no autoplay; codec support decides playback | Core in PR #1844 on Web/Electron |
| HTML | File card | Static preview in an opaque sandbox with restrictive CSP and no scripts/network/forms/popups/top navigation | Core in PR #1844 on Web/Electron |
| DOCX/ODT/RTF; PPTX/ODP; XLSX/ODS | File card | Explicit unsupported state and original file access until isolated conversion exists | ENG-5 |
| HEIC/TIFF/BMP and unsupported image codecs | File card until conversion | Explicit unsupported state until owner-runtime raster conversion exists | ENG-5 |
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

Reuse canonical `attachment_reference` parts for delivered artifacts and the existing `chat_attachments` table for searchable message ownership. Keep image/file kinds; preview kind is derived metadata, not a provider-specific message type. Existing user attachment behavior and input-upload size bounds remain unchanged. The existing 8-attachment message bound also applies to assistant output.

The core implementation persists immutable delivered bytes in owner storage under `data/chat-artifacts/codex/sha256/<hash>.<ext>`. The provider event carries a deterministic session/item/output identity and an owner-relative path; canonical Chat then writes the matching message part and `chat_attachments` row transactionally. A generated artifact is a delivery snapshot; an ordinary Markdown link remains a live owner-file reference and may become missing after deletion.

Only authoritative provider file/image output events or an explicit validated artifact delivery operation create snapshots. Do not scrape arbitrary tool stdout for paths or read every file mentioned by the assistant. Handle text Markdown images/file links independently so all providers benefit even without structured output support. Provider-specific `sandbox:` or temporary absolute paths must map through proven provider-run context; unknown mappings show unavailable, never guess the host path.

Filesystem/DB consistency: read local source files through `O_NOFOLLOW`, verify regular-file identity before and after the bounded read, hash bytes, and publish with exclusive mode `0600`. Inline bytes follow the same 10 MiB bound. The DB transaction validates the active run/message, appends the attachment part, inserts or repairs `chat_attachments`, increments the chat revision and appends the outbox event. Retries reuse the attachment identity and do not duplicate cards or revisions. A process crash after capture but before DB commit may leave an unreferenced immutable owner file; it is visible and owner-deletable through Files, while no dangling Chat reference is published. Reference-aware garbage collection is future lifecycle work rather than unsafe age-only deletion.

### Unified reads and navigation

Add `GET /api/file-previews/metadata` and `GET|HEAD /api/file-previews/content` with strict discriminated query schemas equivalent to FileResourceRef; `download=true` selects Content-Disposition attachment. Reuse the existing file authorization/root-resolution and download-stream primitives. Existing file routes remain compatible. Project and worktree binary reads use the same authorized project resolver as `coding-agents/file-read.ts`, not a general host-filesystem endpoint.

Markdown link/image normalization happens once in shared code; the server repeats authority checks. Resolve relative paths against the originating message execution root, and nested Markdown against its containing directory. Handle spaces, Unicode, URL encoding, line anchors, explicit home aliases and file URLs without double decoding. HTTP(S) links remain web links. Remote images get a labeled external-image placeholder and explicit external-open action initially; do not build an unrestricted image proxy or send credentials to external origins. Bounded provider data-URI image output is ingested into an artifact instead of persisting base64 in transcript JSON.

On Electron, use the existing trusted runtime HTTP transport and captured runtime/auth scope; bearer tokens never enter DOM URLs. On Web, use existing authenticated selected-runtime routing. Shared preview reads are bounded in the renderer; the Gateway stream supports Range and aborts on disconnect. Native Mobile sends its short-lived Clerk authorization header directly to the authenticated image endpoint and never places the token in a query string.

`FilePreviewContent` routes validated descriptors to focused viewers. Electron File Preview and Web Chat consume it; Native Mobile consumes the same persisted attachment path and authenticated read policy through its native image/File Preview adapter. Chat link clicking means Preview. A path outside an admitted root shows unavailable; opening a pane alone is not success.

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

## Implemented limits and deferred conversion limits

- Inline thumbnail: 1024 px longest edge, target <= 1 MiB; 3 concurrent loads; original images <= 40 megapixels for in-process decode, larger files show download/conversion fallback.
- Text/HTML/table renderer read: 1 MiB. CSV/TSV displays at most 500 rows and 100 columns and never evaluates cells.
- Binary renderer read: 50 MiB. Gateway streams in 64 KiB chunks, supports Range, caps concurrent preview streams and applies a 30-second idle timeout.
- Renderer object URLs are revoked on unmount/source change. No unbounded renderer cache is added.
- Artifact snapshot: 10 MiB per provider output and no more than 8 attachments per canonical message.
- Conversion: 50 MiB input, 100 MiB output, 60-second wall time, 512 MiB memory, one worker per runtime, queue <= 8; no network, macros, external links or embedded-object execution. Cap expanded archive bytes to 200 MiB and 10,000 entries before Office parsing; kill worker and clean temp files on timeout/cancel/shutdown.
- Derived cache: owner scoped, hash+converter-version keyed, 512 MiB LRU disk budget, recurring 24-hour unused eviction. Original owner files are never overwritten.
- SVG/HTML: never inject raw markup into the shell DOM. Sanitize active/external references, render isolated output, and test CSP behavior in packaged Electron and Web.

Conversion limits below remain ENG-5 design targets, not shipped behavior. Preview responses use no-sniff and private/no-store; clients receive coarse missing/busy/unavailable states without paths or provider exceptions.

## Surfaces, delivery and acceptance

PR #1844 covers Web Desktop, Web Canvas and Electron Desktop through shared Chat/File Preview code. Native Mobile preserves the same canonical attachment identity, displays authenticated images and opens attachment cards in its File Preview route. Native Mobile PDF/table/audio/video/HTML parity is explicitly deferred until its viewer supports those formats; the core mobile fallback is a named file card and existing unsupported state. No Expo Go acceptance is claimed. Document conversion is enabled only after ENG-5 supplies an isolated runtime service.

Required real validation: generate an image with the configured Codex provider; capture the sanitized actual output event; see the image inline; click to a decoded image in preview; download and compare bytes/hash; reload and cold-start; switch Chat/runtime/worktree and confirm no stale image leakage. Repeat representative Markdown file delivery with another configured provider. Test both home and project/worktree sources and a past message after a new run chooses a different worktree.

Fixtures cover each format and denial state, but do not replace live selected-VPS checks, packaged Electron, Web Desktop/Web Canvas/Web Mobile and Native Mobile device checks. Prepare an exact-head runnable Human Review environment and a short flow. Merge, release publication and VPS rollout remain separate later actions. Public product documentation belongs in `FinnaAI/matrix-os-site`, not a recreated local `www/` tree.

References: [research report](chat-artifact-preview-references-2026-09-22.md). Implementation: [task plan](chat-artifact-preview-plan-2026-09-22.md).
