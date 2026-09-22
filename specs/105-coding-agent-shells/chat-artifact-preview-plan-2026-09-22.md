# Chat artifacts and unified file preview implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task after the user chooses to proceed. Keep each step's red/green evidence. Planning does not authorize deployment or replace Human Review.

**Goal:** Deliver agent images inline and make file links open a reliable shared preview, including PDF, media, text, tables and a subsequent Office conversion increment.

**Architecture:** Normalize provider output and Markdown references into owner/runtime-scoped resources. Use one Gateway authority path, one shared classifier and web preview host, and thin Electron/Web/Native Mobile adapters. Persist structured delivered artifacts independently of transient URLs and mutable workspace files.

**Tech Stack:** Existing TypeScript/Zod 4, React, Hono, Kysely/Postgres, Vitest and authenticated runtime transports; PDF.js worker for portable PDF rendering; isolated owner-runtime conversion worker for Office/image conversion.

**Spec:** [Product and architecture design](chat-artifact-preview-spec-2026-09-22.md).
**References:** [Pinned T3 and official OpenAI findings](chat-artifact-preview-references-2026-09-22.md).
**Baseline:** `096151518c979928433f590a969a17f90cfc4b14`.

## Global constraints

- Read `.specify/memory/constitution.md`; manual worktree and PR required for shipped changes. This plan is in `codex/chat-artifact-preview-plan`; keep the dirty original checkout untouched.
- Rebase/reconcile against current main before implementing; preserve existing user attachments, file downloads, collaboration privacy and unsupported-provider behavior.
- Node 24+, pnpm 10.33.4; `minimumReleaseAge: 10080`; root `pnpm install` after dependency changes; frozen lockfile in CI. Never npm.
- Kysely/Postgres only; related writes in a transaction; retries idempotent; file/DB orphan cleanup explicitly tested.
- Follow every limit, authorization row and platform requirement in the linked spec. Download caps are not preview caps.
- Web Desktop, Web Canvas and Electron Desktop have equivalent capabilities. Web Mobile adapts layout; Native Mobile adapters ship with explicit tested limitations. Preserve brand primitives.
- Large entrypoints only receive wiring; extract focused helpers before adding behavior to files over 1,000 lines. Target modules below 500 lines.
- No arbitrary URL proxy, raw host-file endpoint, renderer credential URL, third-party Office upload, source overwrite, macros, or active HTML execution.
- References inform UX; Matrix contracts, authorization and owner persistence remain authoritative.

## Review focus

1. A past turn references the same filename as a newer run in a different worktree: Task 2 must open the old turn's root or show missing.
2. Image requests complete after switching runtime/account: Tasks 3 and 4 must abort/discard stale results and release Blob URLs.
3. A provider outputs an image event without Markdown, or Markdown without a structured event: Tasks 1, 3 and 4 cover both and deduplicate matched delivery.
4. Same-path workspace bytes change, but captured artifact bytes must not: Tasks 2 and 3 verify version invalidation versus immutable delivery identity.
5. PDFs/media require authenticated Range, while malicious SVG/HTML/Office can load external resources: Tasks 2, 5 and 6 test transport and isolation independently.

## Task 1 — Verify provider output and lock the shared contracts

**Files:** create `packages/contracts/src/file-preview.ts`, `packages/contracts/src/chat-artifacts.ts`, `tests/contracts/file-preview.test.ts`; modify `packages/contracts/src/canonical-chat.ts`, `packages/contracts/src/chat-links.ts`, package export maps and `index.ts`. Extend `tests/gateway/coding-agents-codex-app-server-events.test.ts`. Write sanitized observations to this spec directory.

**Interfaces:** produce `FileResourceRef`, `FilePreviewDescriptor`, `PreviewKind` exactly as defined in the spec; `classifyFilePreview({name, mimeType}): PreviewKind`; `normalizeChatFileReference(raw, context): FileResourceRef | null`, where `context` is a server-verified `{root: home|project, baseDirectory: string}`. A provider-normalized artifact event contains `{providerItemId, runId, source, label, mimeType?}`; `source` is a verified run-local file or bounded image bytes, not a public client field.

- [ ] Capture one actual generated-image run using the configured Codex binary/app-server and one MCP image/file result. Record binary version, event names, output location and whether bytes or paths are returned; redact credentials and unrelated conversation data. Check installed schemas before adding any `imageGeneration` parser. If generated-image capability is unavailable, record that limitation and use a verified recorded event for parser tests; do not claim live success.
- [ ] Add failing tests before schema/parser work. Distinguish downloadable unknown files from blocked paths. Preserve existing uploaded attachment contracts and bounded message counts.

```ts
it('classifies formats without executing or guessing a viewer', () => {
  expect(classifyFilePreview({name: 'report.pdf', mimeType: 'application/pdf'})).toBe('pdf');
  expect(classifyFilePreview({name: 'sales.csv', mimeType: 'text/csv'})).toBe('table');
  expect(classifyFilePreview({name: 'bundle.zip', mimeType: 'application/zip'})).toBe('unsupported');
});
```

- [ ] Run `flox activate -- bun run test -- tests/contracts/file-preview.test.ts tests/contracts/canonical-chat.test.ts`; record expected missing-schema/classifier failures.
- [ ] Implement strict Zod schemas, MIME-aware classification with extension fallback only for generic MIME, home/project/artifact refs, and safe normalized links. Test Unicode, spaces, percent encoding, double encoding, line suffixes, `sandbox:`, file URLs, traversal, root-relative paths and unknown schemes. Map verified provider paths only inside run context. Add a capability/version fallback so older clients see text links instead of rejecting enriched messages.
- [ ] Re-run these suites and the app-server event suite; commit `feat(contracts): define chat artifact preview resources` with sanitized spike evidence.

## Task 2 — Serve authorized binary files consistently across roots

**Files:** create `packages/gateway/src/file-preview-routes.ts`, `packages/gateway/src/file-preview-service.ts`, `tests/gateway/file-preview-routes.test.ts`; wire `packages/gateway/src/server/file-routes.ts`; reuse/extract `coding-agents/file-read.ts`, `path-security.ts`, `file-download-stream.ts`; modify shared download contracts only where needed for project/artifact sources.

**Interfaces:** `resolvePreview(principal, ref): Promise<FilePreviewDescriptor>` and `openPreviewContent(principal, ref, {range?, ifRange?, download?}): Promise<Response>`. HTTP query schema mirrors FileResourceRef; no filesystem root is accepted from a client. Content response version/ETag matches the metadata source version.

- [ ] Write route tests with a real temp home, authorized project, two worktrees and an outside-root symlink. Assert exact PNG bytes (not UTF-8 JSON), PDF content type, `HEAD`, 206/416 and If-Range behavior. For requests from another principal, assert denial before file open.

```ts
it('serves selected bytes without decoding the image as text', async () => {
  const png = new Uint8Array([137,80,78,71,13,10,26,10]);
  // In this suite, seed the fixture's authorized project output.png with png.
  const response = await app.request('/api/file-previews/content?kind=project&projectId=demo&path=output.png', {
    headers: {Range: 'bytes=0-3', Authorization: ownerAuthorization},
  });
  expect(response.status).toBe(206);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(png.slice(0, 4));
});
```

Here `app`, `ownerAuthorization` and seeded roots are the test suite's Hono fixture, following `tests/gateway/file-blob-routes.test.ts`; they are never production constants.

- [ ] Run `flox activate -- bun run test -- tests/gateway/file-preview-routes.test.ts`; record missing-route failures.
- [ ] Extract the existing authoritative project resolver and stream helper; open a validated regular file once, re-check descriptor identity as required, use bounded backpressure, safe Content-Disposition/no-sniff/no-store, and close descriptors on cancel/error/shutdown. Return safe missing/permission/unsupported/too-large outcomes. Preserve existing download resume and no-size-cap behavior.
- [ ] Add regression cases: original message in worktree A followed by a run in B; runtime switch in flight; source truncation/replacement; revoked project membership; no sensitive owner files; empty files; excessive Range; aborted response releases capacity. Validate file-kind detection against trusted bytes where MIME mismatch would enable active content.
- [ ] Run focused routes/download suites; commit `feat(files): unify authenticated preview streams`.

## Task 3 — Ingest, persist and replay generated artifacts

**Files:** create `packages/gateway/src/chat/artifact-ingest.ts`, `artifact-repository.ts`, `artifact-cleanup.ts`, `tests/gateway/chat-artifacts.test.ts`; modify `chat/database.ts` migration registration and canonical message/event persistence; extract `coding-agents/codex-artifact-events.mjs` from app-server lifecycle wiring; wire through `chat/thread-event-inbox.ts` / provider-adapter projection at the verified event entrypoint. Keep provider-specific decoding outside generic artifact persistence.

**Interfaces:** `ingestRunArtifact(principal, event): Promise<{attachmentId: string; state: 'ready'|'unavailable'}>`; unique `(owner, runId, providerItemId, outputIndex)` identity. Artifact records resolve through Task 2's service. Canonical output uses existing `attachment_reference` parts; body bytes never enter broadcast payloads.

- [ ] Add failing tests for image-only events, MCP image results with verified shapes, duplicate/replayed events, DB failure after file publication, interrupted copy, missing temp files, private/non-owner output and post-restart retrieval.

```ts
it('keeps one captured artifact across event replay', async () => {
  const first = await ingestRunArtifact(owner, event);
  const second = await ingestRunArtifact(owner, event);
  expect(second.attachmentId).toBe(first.attachmentId);
  expect(await repository.countByProviderEvent(event)).toBe(1);
});
```

The test-local `repository.countByProviderEvent(event)` queries the artifact table by the unique event identity; it is not a public production interface. `owner` and `event` come from sanitized provider fixtures from Task 1.

- [ ] Run `flox activate -- bun run test -- tests/gateway/chat-artifacts.test.ts`; confirm no existing artifact-delivery path satisfies the fixture.
- [ ] Implement bounded stream/hash/snapshot, then transactional metadata/message/event/outbox persistence. Attach stable source provenance. Emit ready only after durable success. Use an unavailable card for admitted delivery failures. Match duplicate Markdown references by resource identity, never filename alone. A plain linked file remains mutable and does not cause a filesystem-wide import.
- [ ] Implement reference-aware 24-hour orphan/staging cleanup and shutdown drains. Test replay after restart, source deletion after snapshot, shared-Chat output withholding, access revocation, owner export/delete hooks, filename sanitization and the existing 8-attachment boundary. Verify enrichment is not dropped by content projections or WebSocket negotiation.
- [ ] Run contract/provider/persistence/content-projection suites; commit `feat(chat): persist generated file artifacts`.

## Task 4 — Display images and open a single preview surface

**Files:** create `packages/ui/src/files/file-preview-policy.ts`, `use-file-preview.ts`, `FilePreviewHost.tsx`, `packages/ui/src/chat/AssistantArtifacts.tsx`, `tests/ui/file-preview-policy.test.ts`, `tests/desktop/chat-artifact-preview.test.tsx`; wire `components/conversation/message.tsx`, `transcript.tsx`, `features/chat/canonical-chat-presentation.ts`, `CanonicalChatWorkspace.tsx`, `features/work/work-files-scope.ts`, `features/panels/InspectorFilesPanel.tsx`, `features/files/FilePreviewPane.tsx`. Reuse `packages/ui/src/chat/ChatAttachments.tsx` primitives.

**Interfaces:** `FilePreviewHost({descriptor, transport, onDownload})`; `transport` exposes authenticated metadata/read/range methods, abort and scope identity. `AssistantArtifacts({attachments, open, loadImage})` renders canonical output parts; Markdown image overrides resolve through the same resource service. `open(resource)` preserves the originating message/run context.

- [ ] Write failing component tests for structured assistant image without Markdown; Markdown image without structured part; matched duplicates; clicking an image or link opens the same preview; failure displays retry/download; switching account mid-load never paints stale bytes.

```ts
it('uses one resource for inline image and preview', async () => {
  render(<ArtifactConversationFixture source='project' image='whale.png' />);
  await screen.findByRole('img', {name: 'whale.png'});
  await user.click(screen.getByRole('button', {name: 'Preview whale.png'}));
  expect(await screen.findByRole('region', {name: 'File preview'})).toBeVisible();
});
```

`ArtifactConversationFixture` is a test-local wrapper around the real transcript and preview host with an authenticated transport stub returning the fixture PNG; assert its captured project/worktree arguments as well as visible DOM.

- [ ] Run `flox activate -- bun run test -- tests/desktop/chat-artifact-preview.test.tsx tests/desktop/work-files-scope.test.ts`; record failures before wiring.
- [ ] Implement a custom Markdown `img` renderer and assistant attachment group. Reserve image dimensions, load bounded thumbnails, lazy-load offscreen content, use source-version cache keys and revoke object URLs. Resolve links using originating message context. Keep existing inspector tabs/history and keyboard/focus behavior; no parallel modal state system.
- [ ] Replace project text-only preview dispatch and home-only divergent classification with Task 2 descriptors/Task 4 host. Test updated workspace image invalidation and unchanged captured artifact, cancellation, missing files, empty alt text and multiple-image order. Scope cache to runtime/auth generation and root identity.
- [ ] Run focused component/work-files/attachment regressions and Desktop typecheck; commit `feat(chat): show assistant images and unified file previews`.

## Task 5 — Add core viewers and surface parity

**Files:** create focused viewers under `packages/ui/src/files/viewers/` (`ImagePreview.tsx`, `PdfPreview.tsx`, `TextPreview.tsx`, `TablePreview.tsx`, `MediaPreview.tsx`, `HtmlPreview.tsx`), `tests/ui/file-preview-viewers.test.tsx`, `tests/shell/chat-artifact-preview.test.tsx`; wire `shell/src/components/chat/ChatFilePanel.tsx`, `shell/src/components/ChatApp.tsx`, `shell/src/components/preview-window/PreviewTab.tsx`, `apps/mobile/lib/canonical-chat-transcript.ts` and `apps/mobile/app/file-browser/file.tsx`. Create `apps/mobile/components/ChatArtifactPreview.tsx` and its device-oriented test fixture. Add dependency/export/worker packaging changes with their owning viewers.

**Interfaces:** each viewer consumes FilePreviewDescriptor and the Task 4 transport; returns common loading/ready/missing/forbidden/too-large/invalid/unsupported/retryable states and uses the shared explicit download action. Native adapters consume the same contract/policy, not DOM components.

- [ ] Write failing tests for multi-page PDF, code/Markdown, CSV quoted multiline cells, unsupported codecs, no-autoplay audio/video, blocked HTML/SVG active content, over-limit files and download fallback. Include Native Mobile parsing/state tests before adapter changes.

```ts
it('never executes CSV cells as formulas', () => {
  const rows = parsePreviewTable('value\n"=HYPERLINK(""https://example.invalid"")"', ',');
  expect(rows[1][0]).toBe('=HYPERLINK("https://example.invalid")');
});
```

Define `parsePreviewTable(text: string, delimiter: ','|'\t'): string[][]` in the table viewer helper, with the spec's row/column/byte bounds and explicit truncation state returned by its caller.

- [ ] Run `flox activate -- bun run test -- tests/ui/file-preview-viewers.test.tsx tests/shell/chat-artifact-preview.test.tsx`; capture initial failures. Spike PDF.js worker in production Electron/Web CSP and mobile device preview before selecting compatible dependency versions; no iframe-only assumption of cross-platform PDF support.
- [ ] Implement lazy viewers and shared controls. Add bundled PDF worker with authenticated Range. Table parser runs under a bounded worker/time budget. HTML visual mode uses sanitized static output with a restrictive sandbox/CSP; nested Markdown assets remain in the parent resource scope. Media streams without full-file buffering; unsupported decoder states retain download.
- [ ] Wire Web Desktop/Web Canvas/Web Mobile and Native Mobile. Implement scoped Electron media transport if the current one cannot safely stream Range. Verify untrusted renderer cannot choose a host file or inject headers. Native cache has explicit LRU/cleanup; native HTML visual limitation follows the spec.
- [ ] Run relevant Vitest/Jest suites, scoped typechecks, `bun run build:desktop`, `bun run build:shell:production`, and Native Mobile dev-client/device checks through Flox where applicable. Commit `feat(files): preview documents media and tables across surfaces`.

## Task 6 — Owner-runtime document conversion increment

**Files:** create `packages/gateway/src/file-conversion/{service,worker,cache,routes}.ts`, `tests/gateway/file-conversion.test.ts`; extend preview descriptors/service and `FilePreviewHost`; add a dedicated out-of-process converter packaging definition alongside existing host-bundle build/provision scripts. Document operational requirements in this spec before enabling capability.

**Interfaces:** `requestConversion(principal, resource, target): Promise<{jobId, state}>`, where `target` is `pdf|sheet-data|png`; authenticated POST start and GET status/result routes use opaque job IDs bound to owner/resource version. Conversion is idempotent by source hash, target and converter version. Native/web clients observe the same states.

- [ ] Write failing tests for DOCX/PPTX PDF output, XLSX sheet-data bounds, HEIC raster output, missing converter, conversion timeout, cancellation, external links/macros, malformed archives and source change during conversion.

```ts
it('fails safely when conversion exceeds its deadline', async () => {
  const result = await runConversionFixture({fixture: 'never-exits', timeoutMs: 50});
  expect(result.state).toBe('failed');
  expect(result.code).toBe('conversion_unavailable');
  expect(result.liveChildren).toBe(0);
  expect(result.remainingTempFiles).toBe(0);
});
```

`runConversionFixture` is a test harness spawning a controlled child and observing real process/temp cleanup; do not stub away the cleanup under test.

- [ ] Run `flox activate -- bun run test -- tests/gateway/file-conversion.test.ts`; record failures. Spike an owner-runtime LibreOffice-based conversion process plus a bounded sheet extractor and raster converter against representative fixtures. Confirm license, maintained versions, actual CPU/memory limits and network isolation before adopting dependencies. If the host cannot enforce isolation, expose unavailable conversion rather than running it unsandboxed.
- [ ] Implement isolated jobs, capped queue, limits from spec, no network/macros/external links, hash/version cache and recurring cleanup. Never send owner documents to public Office viewers. Original file download remains available even if conversion fails. Sheet preview displays stored values/formulas as text and never executes them.
- [ ] Package provisioned capability separately from ordinary JS dependencies; report unavailable until the runtime converter exists. Test multi-sheet selection, slide/document page navigation, fidelity labels, source revision change and access revocation while queued.
- [ ] Validate representative actual documents on a disposable VPS and across clients, then commit `feat(files): add isolated document conversion previews`. A core-only release must explicitly label this increment as not yet shipped.

## Task 7 — End-to-end proof, documentation and review handoff

**Files:** create `tests/e2e/chat-artifact-preview.test.ts` plus small generated test fixtures and this spec's acceptance evidence. Update public docs in a separate `FinnaAI/matrix-os-site` PR; do not put private incident identifiers in public docs.

- [ ] Add the failing full-path scenario before closing implementation: provider event -> stored artifact -> assistant image -> click preview -> download -> reload. Use a real Gateway/Postgres and real PNG/PDF files; only deterministic provider transport fixtures may be stubbed in CI. Assert decoded image dimensions, PDF page visibility and downloaded SHA-256, not merely a mounted panel.
- [ ] Run focused regressions, canonical typechecks/pattern checks and production builds. Fix failures in their owning task, then rerun affected checks. Preserve source commit and tool versions in evidence.
- [ ] Execute live Codex image generation in an exact-head authenticated review environment; repeat a file/Markdown delivery through another configured provider. Check home/project/worktree, same-name paths, past-turn scope, runtime switch, refresh/cold start, loss of permission, 404, malformed/oversized input and cancellation. Label unavailable provider or physical-device tests as pending rather than passed.
- [ ] Supply a runnable Human Review environment with this flow: ask for an image -> see it inline -> click image -> zoom -> download -> generate/open PDF -> open CSV/audio/video -> restart -> reopen -> switch runtime. Include document conversion flow only when installed. Keep Web Desktop/Web Canvas/Electron Desktop evidence separate; record Web Mobile/Native Mobile outcomes.
- [ ] Open scoped implementation PR(s) with source-of-truth, transaction scope, acceptable orphan states, auth source and deferred scope; attach them to the task. Required CI/Greptile and explicit Human Review precede authorized merge. Publishing artifacts and deploying VPSes are separate, later operations.

## Proposed delivery sequence

1. **Core vertical delivery:** Tasks 1–5 and 7 together fix the reported image path and deliver PDF/media/table previews; intermediate PRs may land behind one capability gate, but do not claim the feature works until the entire path is live.
2. **Document delivery:** Task 6 plus its Task 7 checks adds Office and image conversions. Fallback cards/downloads already work in core.

No estimated dates or measured performance promises are implied. The main implementation risk is preserving resource authority across owner/project/worktree/provider-temp paths and replay; the converter is a separate runtime dependency. Product and engineering decisions above are the proposed defaults for review, not already-shipped behavior.
