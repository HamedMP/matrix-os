# Chat Agent Recipes Implementation Plan

> For agentic workers: use superpowers:executing-plans inline; retain the user's existing PR and manual worktree.

**Goal:** Configure real skills and integration dependencies on saved Agents and verify Personal Daily Brief against the owner's Gmail and Google Calendar.

**Architecture:** Add an optional recipe to the existing file-owned Agent definition. Admission resolves bundled skill content into the immutable canonical Run snapshot; Hermes uses the existing Matrix integrations MCP or bundled command. Shared UI owns template, skill, integration/account and output configuration across the existing Chat surfaces.

**Tech Stack:** TypeScript, Zod 4, React, Vitest, existing Postgres/Kysely ledger and Markdown Agent files.

**Spec:** `specs/121-chat-agent-templates/implementation.md`, extended by Yuhan's September 10 request for recipes and Personal Daily Brief.

## Global constraints

- Keep `MATRIX_CHAT_AGENTS_ENABLED=1` gated; use existing Hermes Full access. Recipe read-only instructions are workflow boundaries, not a new runtime sandbox.
- No email sending, Calendar mutation, automatic scheduling, credential copying, or public user-data artifacts.
- Retain existing Agent IDs/files and historical snapshots. Optional recipe fields preserve old definitions.
- Source skill files live under `skills/matrix/`; never maintain duplicate instruction bodies in the UI.
- Use the existing authenticated integration transport for account metadata. Data reads occur only when the user runs the Agent.
- Keep the separate public site documentation PR paused at the user's instruction; record the public documentation follow-up without publishing it.

## Task 1: Compact titles and old-title compatibility

- [x] Add failing tests in `tests/gateway/chat-agent-context.test.ts` and `tests/shell/canonical-chat-agent-submit.test.tsx`: a 200-character existing title must support Agent/reference admission; a new long prompt must create an ellipsized title at most 80 characters while preserving the message.
- [x] Align `ChatContextSnapshotSchema.title` with canonical persisted titles (200 characters / 1024 bytes), and use `compactChatTitle(value)` for Web automatic titles. Retain Electron's existing concise-title derivation.
- [ ] Run the focused tests; inspect title containment at narrow widths in all three desktop presentations.

## Task 2: Recipe contract and admitted execution

Files: `packages/contracts/src/chat-agent-recipe.ts`, `chat-agents.ts`, `chat-agent-context.ts`; `packages/gateway/src/chat/agent-recipe.ts`, `agent-context.ts`, `agent-routes.ts`; `skills/matrix/personal-daily-brief/SKILL.md`.

- [x] Add failing contract and execution tests for `{ skills: ["matrix-personal-daily-brief", "matrix-integrations"], integrations: [{ service: "gmail" }, { service: "google_calendar" }], output: "English daily brief with source links" }`. Reject unknown skill IDs, duplicate references, oversized snapshots and forged resolved content.
- [x] Add optional typed `recipe` to Agent configuration and bounded `recipe` snapshot to admitted Agent context. Read only server-catalogued skill files, pin their bodies and hashes, and include dependencies/output in the provider prompt. Existing runs use their pinned content after edits.
- [x] Expose authenticated `GET /api/chat-agents/recipe-catalog` using the existing principal/feature checks; return bundled skill metadata and registry service labels, never credentials. Existing CRUD routes keep body limits and revision/idempotency semantics.
- [x] Verify missing skills fail before dispatch with generic errors and existing ordinary Agents remain compatible.

## Task 3: Shared editor and Daily Brief validation

Files: `packages/ui/src/chat-agents/AgentRecipeEditor.tsx`, `AgentEditor.tsx`, `ChatAgentsEntry.tsx`, `client.ts`, `ChatContextReceipt.tsx`; shared UI tests.

- [x] Add failing interaction tests: Personal Daily Brief fills name/instructions/recipe, account selections survive save/reopen, load failures preserve changes, creating the Agent does not run it.
- [x] Load catalog and existing `/api/integrations` metadata through the surface's authenticated transport. Display explicit missing/connected/unavailable states; save chosen skill IDs, service/account labels and output. Keep bounded scrolling and truncated labels.
- [x] Display pinned recipe provenance with the canonical Run receipt.
- [ ] Run focused tests, required type/build checks, React audit and source review. Update the existing PR only after local verification.
- [ ] Publish/deploy the exact Preview version through the already authorized Preview workflow. Exercise Web Canvas, Web Desktop and Electron Desktop. Run the first Daily Brief with actual Matrix-connected Gmail and Calendar; require visible source reads, source-linked output, persistence and no-reload delivery. Missing authorization or connections must remain visible rather than producing fabricated data.
- [ ] Keep PR unmerged until Yuhan's explicit Human Review/merge authorization.

## Local validation checkpoint

At `377be3ba8`, 289 distinct covering tests, five package typechecks and both production builds passed. The single consolidated final fix wave is under scoped re-review. Synthetic UI evidence and its limits are recorded in [evidence/README.md](evidence/README.md). Exact Preview and real intended-account validation remain open.
