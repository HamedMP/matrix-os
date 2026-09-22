# Chat artifact preview references

Date: 2026-09-22. Source/schema research used by PR #1844; no live-product acceptance yet.

## T3 Code: verified source behavior

Reference: `pingdotgg/t3code@aff9318bf46beaf05cc7155b428d3f0b8711efd2`, resolved from the GitHub `main` commits API during this investigation. No usable local T3 source checkout was found in the checked locations. These are source-level findings, not a claim that every installed release has them.

| Area | Verified behavior | Primary source |
| --- | --- | --- |
| File classification | One classifier covers image, video, audio, PDF, HTML, Markdown, text, and unsupported. MIME takes precedence with extension fallback for generic types. UTF-8 text decoding is bounded to 1 MiB and rejects binary content. | [filePreview.ts](https://github.com/pingdotgg/t3code/blob/aff9318bf46beaf05cc7155b428d3f0b8711efd2/packages/shared/src/filePreview.ts) |
| Markdown media resolution | Distinguishes direct URLs, environment filesystem paths, and blocked sources. Relative paths require a workspace root. Filesystem references must become signed asset URLs before reaching a browser/native image component. | [markdownImages.ts](https://github.com/pingdotgg/t3code/blob/aff9318bf46beaf05cc7155b428d3f0b8711efd2/packages/client-runtime/src/markdownImages.ts) |
| Inline chat images | Custom Markdown image renderer routes workspace media through an environment/thread-scoped asset resource, renders direct media separately, and supplies a fallback when it cannot resolve the source. Standalone image blocks reserve space while loading. | [ChatMarkdown.tsx](https://github.com/pingdotgg/t3code/blob/aff9318bf46beaf05cc7155b428d3f0b8711efd2/apps/web/src/components/ChatMarkdown.tsx#L3106) |
| Expanded images | Expanded dialog uses a zoomable image, supports left/right gallery navigation and Escape dismissal, and preserves a focus return target. | [ExpandedImageDialog.tsx](https://github.com/pingdotgg/t3code/blob/aff9318bf46beaf05cc7155b428d3f0b8711efd2/apps/web/src/components/chat/ExpandedImageDialog.tsx) |
| Attachment preview | Captured attachment bytes remain distinct from similarly named workspace files. Preview has origin/name/size chrome, image/video/audio bodies, PDF/HTML frames, Markdown/source and delimited-table/source modes, download, loading, retry, and explicit unsupported states. Stale signed URLs are refreshed rather than assumed permanent. | [AttachmentFilePreview.tsx](https://github.com/pingdotgg/t3code/blob/aff9318bf46beaf05cc7155b428d3f0b8711efd2/apps/web/src/components/files/AttachmentFilePreview.tsx) |
| Workspace preview | Resolves files against environment/thread identity, uses signed assets for media/browser documents, and adds a workspace mutation revision to avoid displaying old image bytes. | [FilePreviewPanel.tsx](https://github.com/pingdotgg/t3code/blob/aff9318bf46beaf05cc7155b428d3f0b8711efd2/apps/web/src/components/files/FilePreviewPanel.tsx) |
| PDF and HTML | PDF uses Chromium's built-in iframe viewer; HTML uses an iframe sandbox with an opaque origin. This is a concrete implementation reference, not proof of uniform browser/native PDF fidelity or a security design to copy unchanged. | [BrowserDocumentFrame.tsx](https://github.com/pingdotgg/t3code/blob/aff9318bf46beaf05cc7155b428d3f0b8711efd2/apps/web/src/components/files/BrowserDocumentFrame.tsx) |

The inspected classifier and attachment renderer do not establish DOCX/XLSX/PPTX rendering. They also do not prove that all provider-generated images arrive as structured assistant attachments. Do not infer those capabilities from generic attachment support or artifact-template cards.

## Codex / OpenAI desktop reference

The current official [Codex app features URL](https://developers.openai.com/codex/app/features) redirects to OpenAI's ChatGPT Learn features documentation. Its linked [Work with files](https://learn.chatgpt.com/docs/artifacts-viewer) page currently describes the **ChatGPT desktop app**: generated documents, presentations, spreadsheets and PDFs can be previewed alongside a chat; automatic opening after task completion is optional. It also describes HTML rendered/source views when available and annotations on supported previews. The same page explicitly distinguishes the CLI, which lacks a visual preview interface.

This supports the interaction direction of a chat-linked artifact viewer, but the documentation's current branding must not be silently represented as an exact Codex build compatibility matrix. No particular Office extension fidelity, conversion engine, supported size limit, or browser/native parity was established. A local Codex reference directory found during discovery contained subagent UI bundles only; it did not provide relevant artifact renderer source. No Codex product UI was driven for this report.

The active Codex desktop tool contract in this session separately exposes `open_in_codex` with a local file target and optional line; its app instructions permit local image/video/audio references with absolute paths. These are available integration contracts, not independent pixel-level validation of every format.

## Reusable design decisions for Matrix

1. Treat an artifact as an identified resource on its owning runtime. Resolve Markdown paths through the same authorized resource layer used by file preview; never pass a VPS path straight to browser `src`.
2. Use one file-kind decision and one preview entry point for chat links, assistant attachments, Files, and project files. Keep captured output identity distinct from a mutable file with the same name.
3. Make images useful immediately in the transcript, then open an expanded/full preview on click. Use compact named cards for documents and explicit loading/error/unsupported states rather than empty panels or broken-image icons.
4. Keep filename, format, size, open/download and retry consistent across formats. Add rendered/source views for Markdown, HTML and tabular text where useful.
5. Plan token expiry, runtime reconnect, same-path file replacement, source disappearance and history reload as normal states. A signed URL is delivery state, not persistent artifact identity.
6. Classify Office documents, archives, 3D assets and unknown binary formats explicitly. Promise only the renderer/converter coverage actually implemented; retain a usable download fallback.

These are recommendations derived from the sources, not evidence that Matrix currently implements them. Reuse UX principles, not T3's persistence, runtime, authorization model, or numerical limits. Matrix's own auth matrix, owner boundaries and resource policies govern the implementation.

## Codex app-server schema observation

On 2026-09-22, the locally installed `codex-cli 0.153.4` generated the TypeScript app-server protocol through `codex app-server generate-ts --experimental --out <temporary-directory>`. This was a schema capture, not a successful paid/live image-generation run.

Confirmed resource-bearing `ThreadItem` shapes are:

- `imageGeneration`: `result`, `status`, optional `savedPath`, failure and prompt metadata. A completed item may deliver a saved local path or bounded data result.
- `imageView`: an absolute `path`.
- `functionCallOutput`: output content may include `input_image.image_url` and `input_audio.audio_url`.
- `dynamicToolCall`: `contentItems` may include `inputImage.imageUrl` and `inputAudio.audioUrl`.
- `mcpToolCall`: `result.content` is open MCP content and can carry standard image, audio, embedded resource and resource-link blocks.

The same union also includes messages, plans, reasoning, commands, file changes, web search, sleep/review/compaction state and collaboration activity. Those are activity or text records, not automatic artifact deliveries. Command stdout, file-change paths and web-search results must not be scraped for file references.

PR #1844 normalizes the five explicit resource channels above. It admits local run files and bounded inline bytes, then emits only owner-relative references. Remote HTTP(S) media remains an external reference until a separate authorized fetch policy exists; encrypted content and arbitrary text remain non-artifact output. `outputAudio/delta` belongs to the realtime voice stream rather than a durable completed `ThreadItem`, so it is intentionally not persisted as a Chat file by this change.
