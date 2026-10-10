---
status: active
---
# Local discovery and bulk Chat import

Electron Desktop discovers local conversations under the trusted Claude and Codex roots. All found conversations start selected; owners can deselect them before choosing Import. Optional per-conversation previews support title editing; only the checked list initiates import. Each becomes a distinct private canonical Matrix Chat. Web Canvas and Web Desktop retain explicit local file selection because browsers cannot read home directories.

## Requirements

- R1: Automatically discover Claude Code and Codex local sessions, with search, source filtering and bounded selection. No Electron file picker.
- R2: Show all discovered sessions, select all by default, support deselection/search/app filters and 100-row browsing pages with no selection cap. Import directly by preparing/uploading/releasing one transcript at a time; optional previews allow renaming. Preserve successes, retry failures and stop immediately without accepting late completion.
- R3: Imported sessions appear in the Chat app with a minimal source icon and All/Imported/Claude Code/Codex filtering, derived from durable import provenance rather than the active execution harness.
- R4: Keep originals unchanged, preserve source archives and idempotent upload identity, bind all native operations to current owner/runtime/auth generation, never accept renderer paths, skip symlinks, cap and expire discovery/preview state.
- R5: Focused regressions, visual review, worktree implementation PR, and a separate documentation PR in FinnaAI/matrix-os-site.

## Implementation Units

### U1. Native discovery and source library
Goal: discover transcript candidates, expose opaque identifiers and prepare only owner-selected sessions.
Files: desktop/src/main/files/local-chat-import*.ts; desktop/src/shared/local-chat-import-ipc.ts; desktop/src/main/ipc/local-chat-import.ts; desktop/src/main/index.ts; desktop/src/renderer/src/features/settings/sections/ChatImportSection.tsx; packages/ui/src/chat-import/LocalChatLibrary.tsx; tests/desktop/local-chat-import*.test.ts.
Approach: bounded, symlink-safe scanning with bounded metadata reads; native catalog IDs resolve inside main only; preview selected files through existing captured-byte parser.
Execution note: test-first.
Patterns: existing native import auth binding, original byte capture, IPC schema validation.
Test scenarios: missing roots, both tools, large directory, symlinks, subagents, opaque IDs, stale auth, unknown IDs, partial preview failures.
Verification: native discovery/IPC/service tests and desktop typecheck.

### U2. Shared bulk selection/upload
Goal: separate private chats with per-session progress, retry and opening.
Files: packages/ui/src/chat-import/ChatImportPanel.tsx; use-chat-import.ts; import-state.ts; ImportChatRow.tsx; chat-import.css; packages/ui/package.json; shell/src/app/globals.css; desktop/src/renderer/src/design/index.css; tests/ui/local-chat-import*.test.tsx.
Approach: capped queue, source identity dedup, sequential uploads using unchanged original archive protocol; shared theme tokens.
Execution note: test-first.
Patterns: uploadLocalChatArchive, safe display errors, generation guards.
Test scenarios: mixed harnesses, duplicate previews, retry preserving successes, hung upload cancellation, preview progress/Stop, late completions, deselection after preview, lost-response retries after append/removal, changed-prefix rejection before upload, grouped completion updates, invalid titles, all-selected defaults, deselection, >32 imports, >200 discovery, paging without truncation, reservation and original byte browser upload.
Verification: UI and contract regressions, synthetic visual preview in light/dark and narrow layouts.

### U3. Chat source projection and filtering
Goal: show imported chats in ordinary Chat history with accurate source icons and shared source filter semantics.
Files: packages/contracts/src/canonical-chat-api.ts; packages/gateway/src/chat/import-source.ts; metadata-repository.ts; repository.ts (small wiring extraction only); packages/ui/src/chat/ChatImportSource.tsx; packages/ui/src/index.ts; desktop/src/renderer/src/features/chat/CanonicalChatIndex.tsx; shell/src/components/ChatApp.tsx; shell/src/components/chat/ChatTitleRename.tsx; focused gateway/contracts/UI tests.
Approach: add optional immutable source projection from published owner import records, preserving compatibility; reuse one filter helper and icon component across clients, independent of live provider binding.
Execution note: test-first.
Patterns: canonical record strict validation, owner-scoped DB reads, existing Chat list and ConversationMeta.canonicalRecord.
Test scenarios: Claude/Codex imports read back in list/details, ordinary chats unmarked, failed/unpublished/foreign imports excluded, live provider changes retain source, shared filters combine with search.
Verification: source projection and list UI tests, desktop and shell typechecks.

## Authorization

Existing HTTP upload routes and their personal owner/body limits remain unchanged. Native discover/reserve/prepare/release operations accept only runtimeSlot/authGeneration and opaque catalog IDs, require trusted main-frame IPC and a signed-in matching owner. No renderer-selected paths, roots, tokens or storage URLs. Discovery reads metadata locally; only selected transcripts are fully previewed, and explicit Import uploads originals. Catalogs retain all found candidates within a 20,000-entry defensive traversal budget. Selected catalog IDs reserve 24hours for a long queue; previews still use the internal 32-item transport cap and 128-capture memory cap. The UI prepares only one transcript at a time, so these transport limits never cap the owner selection. Catalog and selection state expire and drain on account changes/shutdown. Browser imports retain explicit file consent.

## GitHub Stack Plan

The implementation is split into two native GitHub stack layers under ENG-184:

1. Source provenance, minimal icons and shared Chat filters, including opt-in response versioning for older clients.
2. Electron Desktop discovery and all-selected bulk import: deselection, paging, optional previews and streaming upload.

The site documentation PR is separate. Each layer remains below 50 files and 3,000 additions. Both implementation layers stay draft until affected live surfaces have screenshots/recordings and the linked tech-channel evidence required by AGENTS.md. The stack must merge atomically so the combined behavior is qualified together.
