# Electron Chat artifact UX

Tracking: ENG-44, with ENG-45 through ENG-48. One implementation PR.

## Problem and evidence

Electron Desktop users receive passive app-directory chips and local image links instead of directly usable artifacts. Chat's File Preview lacks Download and Copy image actions. ENG-4 / PR #1857 already delivered structured image attachments and rich file previews; the missing path is Markdown and inline-code file references and the canonical Chat inspector wiring.

The current assistant sanitizer reproduces `[redacted path]` for the public product route `/api/integrations`. PR #1929 addressed Claude URL fragments across streaming chunks, a different mechanism. The original reported conversation's unsanitized output, provider and installed versions remain unavailable; the screenshot alone does not establish its exact root cause. Already persisted redacted text cannot be reconstructed.

## Behavior

- Preserve only the exact public product route names `/api/apps` and `/api/integrations`. Absolute host paths, private descendants, query strings and credentials retain redaction.
- Resolve installed app directory and entry-point references against the runtime-scoped app catalog. Open the normal Electron app tab. Source files and unknown directories retain file/folder semantics.
- Render owner-local Markdown images, image links and explicit inline-code image paths through authenticated bounded reads. Use the existing image lightbox and File Preview navigation. Failed loads are retryable.
- Chat File Preview resolves both home and project/worktree resources through the existing typed preview API. HTML remains script-disabled and network-blocked; interactive charts open as installed apps.
- Home downloads use the existing native Save dialog and streaming download service. Project downloads use a bounded authenticated blob download. Copy image writes rasterized PNG pixels with byte/dimension limits, completion and safe failure feedback.
- Runtime changes, authentication changes and preview replacement invalidate in-flight image actions. Object URLs and decoded image buffers are released.
- App-builder guidance presents clickable owner-relative app directories and Markdown chart images, without claiming a renderer limitation that has not been observed.

## Scope and invariants

The requested product surface and acceptance target are Electron Desktop. Shared contracts and UI primitives carry the new capabilities; additional Web and Native Mobile navigation integration is deferred by the user's explicit Electron scope. No new endpoint, permissions, persistence or dependency is introduced. No arbitrary HTML script execution or host-path exemptions are added. Public-site documentation changes are excluded from this implementation scope.

Source of truth: the authenticated runtime's installed catalog and file-preview metadata; persisted run execution roots select home versus project/worktree reads. Auth authority remains the existing runtime-scoped API and native download service. There are no related database writes or new orphan states.

## Review regressions

- Preserve exact public route references followed by prose punctuation; keep descendants, queries and fragments redacted.
- Resolve Browser through the shared catalog path aliases.
- Preserve the first 64 KiB of large project text/Markdown with a truncation notice through authenticated range reads.
- Offer buffered project downloads only up to 50 MiB and explain the limit for larger files. Home downloads retain native streaming without this buffer limit.

## Validation and delivery

1. Contract and streaming-redaction regressions, including all split boundaries and private-path counterexamples.
2. Renderer tests for app launch versus source-file navigation, inline image representations, and preview actions.
3. Image-copy tests for PNG output, stale scopes, oversized images and bitmap cleanup.
4. Type checks, production Electron build and existing rich-preview regression suites.
5. Disposable Preview VPS containing the exact PR head. Run the built Electron client against that VPS, recording client SHA, installed host release, app launch, PNG rendering, HTML/chart preview, actual downloaded bytes and native clipboard image pixels.

Keep the PR unmerged for review. Preview is register-only and does not promote or deploy production channels. Record any runtime acceptance blocker explicitly and ask about deleting the disposable Preview VPS after validation.
