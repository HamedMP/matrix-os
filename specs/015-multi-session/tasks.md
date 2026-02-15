# Tasks: Multi-Session + Approval Gates

**Task range**: T620-T636
**Parallel**: PARTIAL -- Multi-session (T620-T629) and Approval gates (T630-T636) are independent of each other. Both can run in parallel with other specs. Multi-session touches dispatcher.ts and ConversationStore. Approval gates touch hooks and add a new WebSocket protocol.
**Deps**: None for multi-session. Approval gates need existing PreToolUse hook infrastructure (already in kernel).

## Part A: Multi-Session Support

### User Story

- **US-MS1**: "I can create new conversations and switch between them in the same channel, and the AI can peek at previous chats for context"

### Architecture

Current state: One `sessionId` per channel connection. ConversationStore maps `sessionId -> conversation file`. Shell has a conversation switcher but creates new sessions by generating a new UUID.

Target state: Users can explicitly create new sessions. Dispatcher routes messages by session. Kernel gets a `search_conversations` IPC tool to grep previous sessions for context when relevant.

Key files touched:
- `packages/gateway/src/conversations.ts` (ConversationStore)
- `packages/gateway/src/dispatcher.ts` (session routing)
- `packages/kernel/src/ipc-server.ts` (new IPC tools)
- `shell/src/hooks/useChatState.ts` (session management)
- `shell/src/components/ChatPanel.tsx` (UI)

### Tests (TDD -- write FIRST)

- [ ] T620a [P] [US-MS1] Write `tests/gateway/conversations.test.ts`:
  - `createSession()` returns new session with unique ID
  - `listSessions()` returns all sessions with metadata (preview, message count, timestamps)
  - `searchAcrossSessions(query)` returns matching messages with session IDs
  - `deleteSession(id)` removes session file
  - Sessions are isolated (messages in one don't appear in another)
  - Search returns results ranked by recency

### Implementation

- [ ] T621 [US-MS1] Extend `ConversationStore` interface:
  - Add `create(channel?: string): string` -- creates new session, returns ID
  - Add `delete(id: string): boolean` -- removes session file
  - Add `search(query: string, opts?: { limit?: number }): SearchResult[]` -- grep across all session files, return matching messages with session context
  - `SearchResult`: `{ sessionId, messageIndex, role, content, timestamp, preview }`
  - Search implementation: iterate session files, `String.includes()` or simple regex per message. No vector DB needed.

- [ ] T622 [US-MS1] Add IPC tools to `ipc-server.ts`:
  - `new_conversation` -- creates a new session via ConversationStore, returns session ID
  - `search_conversations` -- searches across all sessions. Params: `{ query: string, limit?: number }`. Returns matched messages with session context. Kernel uses this to peek at previous conversations when it thinks context from another chat is relevant.

- [ ] T623 [US-MS1] Dispatcher session routing:
  - Dispatcher already receives `sessionId` from WebSocket connection
  - Add `POST /api/conversations` endpoint to create new session (returns `{ id }`)
  - Add `DELETE /api/conversations/:id` endpoint to delete session
  - WebSocket `switch_session` message type: client sends `{ type: "switch_session", sessionId }`, server acknowledges and routes subsequent messages to that session

- [ ] T624 [US-MS1] Shell integration:
  - `useChatState` hook: add `createSession()` that calls `POST /api/conversations`, switches to new session
  - `ChatPanel`: "New Chat" button calls `createSession()` instead of just generating UUID client-side
  - Conversation list shows all sessions from API

### Implications

- ConversationStore changes are backwards-compatible: existing sessions continue working.
- `search_conversations` is intentionally simple (string match, not vector search). For RAG-quality search, see 016-memory spec.
- Session deletion removes the JSON file -- kernel context from that session is gone. This is file-first: user can also just delete the file manually.
- Kernel should NOT automatically search previous sessions on every message (expensive). It uses the tool when it detects the user referencing something from a previous conversation.

---

## Part B: Approval Gates

### User Story

- **US-AG1**: "The OS asks my permission before doing destructive or irreversible actions"

### Architecture

Current state: PreToolUse hooks exist in kernel (protected files hook denies writes to constitution/kernel/tests). No user-facing approval flow.

Target state: Certain tool calls trigger a WebSocket approval request to the shell. Kernel blocks until user approves/denies. Configurable policy in `config.json`.

Key files touched:
- `packages/kernel/src/hooks.ts` (approval hook)
- `packages/gateway/src/server.ts` (WebSocket approval protocol)
- `packages/gateway/src/dispatcher.ts` (approval flow orchestration)
- `shell/src/components/ApprovalDialog.tsx` (new)
- `shell/src/hooks/useSocket.ts` (approval messages)
- `home/system/config.json` (approval policy)

### Tests (TDD -- write FIRST)

- [ ] T630a [P] [US-AG1] Write `tests/kernel/approval.test.ts`:
  - `shouldRequireApproval(toolName, args)` returns true for destructive ops (Bash with rm/kill, Write to system files)
  - `shouldRequireApproval()` returns false for safe ops (Read, list_tasks)
  - Custom policy from config overrides defaults
  - Timeout triggers auto-deny

- [ ] T630b [P] [US-AG1] Write `tests/gateway/approval.test.ts`:
  - WebSocket sends approval request when hook triggers
  - User approval resumes tool execution
  - User denial aborts tool with error message
  - Timeout (30s default) auto-denies

### Implementation

- [ ] T631 [US-AG1] Define approval policy types in `packages/kernel/src/approval.ts`:
  - `ApprovalPolicy`: `{ requireApproval: ToolPattern[], autoApprove: ToolPattern[], timeout: number }`
  - `ToolPattern`: `{ tool: string, argPatterns?: Record<string, string> }` -- e.g. `{ tool: "Bash", argPatterns: { command: "rm|kill|drop" } }`
  - Default policy: require approval for `Bash` (with destructive patterns), `Write` (to `system/` paths). Auto-approve: `Read`, `list_tasks`, `read_state`, `load_skill`.
  - `shouldRequireApproval(toolName, args, policy)`: evaluates tool call against policy.

- [ ] T632 [US-AG1] Implement approval hook in `packages/kernel/src/hooks.ts`:
  - New `createApprovalHook(policy, requestApproval)` returning a PreToolUse hook
  - `requestApproval` is an async callback injected by gateway: `(toolName: string, args: unknown) => Promise<boolean>`
  - Hook calls `shouldRequireApproval()`, if true, calls `requestApproval()` which blocks until user responds
  - Returns `{ decision: "allow" }` or `{ decision: "deny", message: "User denied" }`

- [ ] T633 [US-AG1] WebSocket approval protocol in gateway:
  - Gateway sends: `{ type: "approval_request", id, toolName, args, timeout }`
  - Shell responds: `{ type: "approval_response", id, approved: boolean }`
  - Dispatcher injects `requestApproval` callback that sends WS message, creates a Promise, resolves on response
  - Timeout: if no response in `policy.timeout` ms, auto-deny

- [ ] T634 [US-AG1] Shell `ApprovalDialog` component:
  - Modal dialog showing tool name, arguments summary, approve/deny buttons
  - Countdown timer showing remaining timeout
  - Auto-dismiss on timeout (denied)
  - `useSocket` hook: listen for `approval_request`, show dialog, send `approval_response`

- [ ] T635 [US-AG1] Approval policy in `home/system/config.json`:
  - Add `approval` section to config
  - ```json
    "approval": {
      "enabled": true,
      "timeout": 30000,
      "requireApproval": ["Bash:destructive", "Write:system"],
      "autoApprove": ["Read", "list_tasks", "read_state"]
    }
    ```
  - Gateway reads policy from config on startup and hot-reload

- [ ] T636 [US-AG1] Telegram channel approval:
  - When approval needed for Telegram-originated message, send inline keyboard with Approve/Deny buttons
  - Map Telegram callback to approval response
  - Same timeout behavior

### Implications

- Approval hook runs BEFORE the existing protected-files hook. If approval denies, protected-files never fires.
- The `requestApproval` callback is async and blocks the kernel's tool execution. Agent SDK supports this via hook return value.
- Approval adds latency to tool calls. Default policy should be minimal (only truly destructive ops).
- config.json schema grows. Validate with Zod on load.
- Future: approval could expand to financial actions (fal.ai image gen costs money), external API calls.

## Checkpoint

- [ ] Create new session from shell, switch between sessions, messages route correctly.
- [ ] Ask kernel about something discussed in a previous chat -- it uses `search_conversations` to find context.
- [ ] Kernel attempts `Bash rm -rf` -- approval dialog appears, user denies, tool is blocked.
- [ ] `bun run test` passes.
