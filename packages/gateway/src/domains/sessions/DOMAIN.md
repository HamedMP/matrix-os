# DOMAIN: `sessions` — agent sessions, conversations, dispatch

Owns the agent-session lifecycle: launching, sandboxing, session registry,
conversation stores and lifecycles, dispatch. The largest domain; Phase 3
merges its conversation stores into one `AgentSessionRepository`.
May import `terminal` (runtime), `workspace` (projects), `files`,
`identity`, `_shared`.

## Contents

Sessions: `agent-launcher.ts` · `agent-sandbox.ts` ·
`agent-session-manager.ts` · `session-registry.ts` ·
`session-runtime-bridge.ts` · `session-store.ts` ·
`session-transcript.ts` · `session-startup-diagnostics.ts` ·
`agent-terminal-cwd.ts` · `agent-profile-summary.ts` ·
`background-agent-runtime.ts` · `background-runtime-lock.ts` ·
`background-session-lifecycle.ts`
Conversations: `conversations.ts` · `conversation-*.ts` (lifecycle,
context, runs, summary, approvals, locks, reconnect-aborts)
Dispatch/approvals: `dispatcher.ts` · `approval.ts` · `prompt-validation.ts`

## Decision log

- 2026-09-16 (Phase 1-A3/W4): `dispatcher.ts` placed here (message routing
  into sessions), not the app layer. `approval.ts` / `prompt-validation.ts`
  likewise — agent-run concerns.
- `chat/` and `coding-agents/` folders stay at `src/` root this phase;
  Phase 3 unifies them with these stores.
