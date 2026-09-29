# Browser-first public tool suite

**Status:** Implementation target  
**Owner:** Matrix public website  
**Date:** 2026-09-29

## Outcome

Extend the 45 working public Matrix tools with the distinct TabTasker tasks. Keep each task usable on a phone without a Matrix account or provisioned computer. Publish a page in the sitemap only when the task works end to end. Retain Matrix site design, clear limits, and accurate descriptions. The catalog is a product inventory, not permission to publish placeholder pages.

## Inventory and acceptance

| Family | Tasks | Acceptance |
|---|---|---|
| Documents | PDF workspace, edit, merge, split, compress, render to image, extract to Word, extract to Excel, watermark, rotate, edit metadata, page numbers, unlock, protect, redact, OCR, compare, verify, podcast, e-sign | Each consumes a local PDF and produces a valid downloadable result or a precise unsupported-input error. Redaction removes underlying content. Password features use real encryption/decryption. Visual signatures are labeled as such; cryptographic verification is separate. |
| Images | Workspace, convert, compress, resize, upscale, background removal, EXIF, color picker, images to PDF, blur faces, caption, zero-shot tags, OCR | Canvas or local WASM/model processing; user can preview and download the result. AI model downloads are clearly disclosed and cached locally where supported. |
| Text and data | Text workspace, full Markdown editor, CSV editor, CSV to PDF, summarizer, sentiment, text-to-speech | Interactive editing and valid export. AI uses local model by default; browser speech is clearly marked by availability and voice support. |
| Audio | Workspace, speech to text, convert, trim, transcription player, compress, denoise, pitch/speed | Browser Web Audio/MediaRecorder and local WASM/model processing; sample rate, format, and browser limitations disclosed. |
| Developer | JWT decode and optional signature verification, code workspace, QR generation, password generation, password strength | No secret leaves the browser. Code execution is sandboxed away from the site origin. JWT decode does not claim signature verification. |
| Collaboration | Video call, file share, whiteboard, workflows | WebRTC media/data channels where peers are involved. Participants manually exchange bounded offer/answer codes for the free version. File transfer is peer-to-peer with chunk limits and backpressure; no Matrix server stores files. Workflows execute locally or require explicit Matrix account for durable schedules. |
| AI | Local AI chat | Explicit local-model download, resource controls and device fallback. Optional Matrix AI gateway path requires authenticated access, a per-owner budget, rate limits, and an existing eligible route; free anonymous calls may not consume unbounded Matrix funds. |
| Existing-tool depth | SEO audit from local HTML file or validated URL, plus Hash, UUID, regex, URL, color, cron, diff, text-cleaner and case-converter improvements | Preserve current slugs. URL audit requires a separate safe fetch proxy with SSRF protection; never call arbitrary sites from the Matrix gateway without DNS/IP validation and redirect rejection. |

The PDF Workspace, Image Workspace, Audio Workspace, Text Workspace, Code Workspace, and Workflows are real multi-action editors, not alternate pages that repeat a single tool. The directory may use task groups, but each unique slug needs a distinct, useful action and original page copy.

## Architecture

- Website App Router serves static metadata, catalog, help content, and a client-only task component. Processing is lazy loaded by task family. No user file goes to the website server, analytics, or Matrix computer by default.
- Browser processing uses Canvas, Web Audio, Web Speech where available, Web Crypto, streams, and vetted browser-compatible PDF/AI/WASM libraries. Use Web Workers for OCR, media transcoding, and local inference. Abort on navigation; clean workers, tracks, object URLs, timers, and model resources.
- Collaboration uses WebRTC RTCPeerConnection and RTCDataChannel. The initial free version uses manual copy/paste of bounded offer and answer codes, so no Matrix signaling endpoint, database, or server startup wiring is required. Each peer gathers ICE candidates before sharing its code. Public STUN helps direct connections; there is no TURN relay, so some networks will not connect. Tell users when connection fails. Video tracks stop when leaving, and shared whiteboard operations are capped. A future one-link room experience needs a separate signaling service specification with explicit website-to-gateway routing, startup, Postgres configuration, abuse limits, and shutdown behavior before implementation.
- Durable background workflows, cloud files, scheduled execution, and hosted AI belong to paid Matrix accounts and do not masquerade as browser tools. A free browser workflow must run only while the tab remains open.
- Do not fetch user-provided URLs server side until a dedicated SSRF-safe endpoint is designed and tested. A local HTML upload satisfies the first SEO-audit expansion.

## Security and resource policy

| Route or operation | Auth | Boundary | Persistence |
|---|---|---|---|
| `GET /tools`, `GET /tools/[slug]` | Public | Catalog slug allowlist | None |
| Local tool execution | None | File type, size, page/frame/duration, output, model-memory caps | Browser only |
| WebRTC offer/answer exchange | Participant manually shares the code | Bounded code size, participant count, connection time, and data-channel messages | Browser memory only |
| AI gateway | Existing Matrix owner auth and funding policy | Existing model entitlement, budget reservation and rate limit | Existing owner ledger only |
| URL audit proxy, if later added | Public with strict rate limit | DNS+IP SSRF denial, redirect error, timeout, response cap, content-type check | No body persistence |

Every new server endpoint uses Zod 4 boundary validation, Hono bodyLimit for mutations, generic errors, 10s external call deadlines, bounded maps with TTL/eviction, and explicit shutdown cleanup. Multi-write Postgres operations are transactional. The initial collaboration tools add no server endpoint. Never log file contents, peer SDP, passwords, tokens, or AI prompts. If a library cannot provide true encrypted PDF editing or content removal, omit that page until it can.

Client limits begin at 50 MB per file, 200 PDF pages, 60 minutes of audio, 5 minutes of video, 2 concurrent local AI jobs, 1 GB maximum decoded working set, and 10 minutes of inactivity for collaboration rooms. Each family can set lower limits based on measured memory. Reject over-limit inputs before decode and show useful guidance. Object URLs and tracks are always released.

## UX and SEO

Each page has unique title, description, canonical, H1, task-specific instructions, supported formats, privacy statement, limits, browser availability, and related tools. The Matrix site brand components and responsive layout apply at 375 px, 768 px, and desktop. The main action must work with keyboard and touch, surface progress/cancel, and offer a local download or copy. Do not use generic SEO copy or claim an operation that only partially works. Add only functional slugs to sitemap and structured data. Search Console and Ahrefs evidence prioritize implementation order, not keyword stuffing.

## Verification and delivery

1. For each family write failing unit/contract tests before implementation. Test file signatures, corrupt/oversized files, output validity, cancellation, worker cleanup, and user-visible error classification. Run a browser journey for each task, including downloads and a real sample asset.
2. Add site implementation and public docs in separate PRs. Update this spec in a Matrix worktree PR. Review at mobile, tablet, and desktop widths and check document overflow.
3. Verify no user content appears in telemetry or network requests for local tasks. Verify every published slug resolves with unique metadata and sitemap entry. Unknown slugs 404.
4. For collaboration, integration test two peers, failed ICE, transfer cancellation, and browser resource limits. There is no server room state to expire in the initial version. For AI, test no-budget and model-unavailable paths without spending owner credit if an authenticated gateway path is later added.
5. Every PR includes source of truth, transaction/lock scope, orphan states, auth source of truth, and deferred scope; merge only after Greptile gives current head 5/5. Label `ready-for-ci` at that score. After merge, remove only verified clean worktrees.

## Delivery boundaries

The site implementation is split into working vertical slices: (1) local structured/browser utilities, (2) document and image processing, (3) audio and local AI, (4) peer collaboration through manual WebRTC setup. Each slice ships only its finished pages. A separate future slice may add one-link signaling after its routing and operations are specified. The overall outcome is complete only when the full inventory above is demonstrably working; a spec or catalog entry alone does not count.

## Current delivery record (2026-09-29)

The public website implementation is under review in `FinnaAI/matrix-os-site` PR #137, with separate user documentation in PR #138. Its catalog contains 98 published slugs, including the prior 45. The Vercel preview served all 98 tool pages with HTTP 200, unique titles, the expected canonical, one H1, visible task-specific FAQs and FAQ structured data. The sitemap includes all 98, and an unknown slug returns 404. The site suite passed 185 tests, TypeScript checking, and a production build.

Browser journeys confirmed blur faces, PDF-to-Word, PDF-to-image, merge PDFs, and single-area redaction. A two-page sample PDF uploaded and rendered the live redaction preview in the deployed preview; drawing and exporting several areas across pages still needs a full browser journey. The PDF redaction implementation validates up to 50 selected areas and rasterizes every page so original selectable text is removed. Original Matrix illustrations are used for eight tool categories, and the pages retain Matrix branding and icons.

The full target inventory above is **not yet met**. The current PDF workspace combines files but lacks TabTasker's page thumbnails, page-level reordering and rotation. Visual PDF signing does not create a cryptographic signature; PDF inspection does not verify one. Image upscaling uses browser interpolation rather than an AI super-resolution model. Audio workspace handles one short file and does not persist sessions. Speech transcription, image captioning, PDF-to-podcast, and local AI chat are not published because their browser flows have not passed verification. Image tagging was withheld because the tested MobileCLIP weights are [restricted to non-commercial research](https://github.com/apple-aiml-research/ml-mobileclip/blob/main/LICENSE_MODELS); a commercially usable model must be selected and verified. WebRTC tools use manual code exchange without hosted signaling or TURN, as specified above. These remain separate acceptance items, not claims of completed parity.
