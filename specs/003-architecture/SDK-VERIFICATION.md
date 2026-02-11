# SDK Verification Report

Cross-reference of Matrix OS architecture specs against actual Agent SDK docs and Claude Code docs.

**Legend:**
- **CONFIRMED** -- spec matches docs
- **WRONG** -- spec assumes X, but docs say Y
- **UNCLEAR** -- docs don't explicitly cover this, needs testing
- **N/A** -- CLI-only feature, not available in SDK
- **PARTIAL** -- partly correct, but important details differ

---

## Decision: Use V2 Preview SDK

Matrix OS will use the **V2 TypeScript SDK** (`unstable_v2_createSession` / `unstable_v2_resumeSession`) instead of V1 (`query()`).

**Why V2 is a better fit:**
- Kernel loop is naturally `send()` -> `stream()` -> process -> `send()` again
- V1 requires managing a shared async generator for both input and output, which is awkward when doing work between turns
- Session resume is a dedicated function (`unstable_v2_resumeSession`) instead of an option flag
- One-shot queries are simpler (`unstable_v2_prompt()` returns a result directly)

**Risk:** V2 is explicitly marked **unstable preview**. APIs may change before stabilization. Acceptable for hackathon, needs monitoring for longer-lived use.

**Missing in V2:** Session forking (`forkSession`), some advanced streaming input patterns. Neither is needed for Matrix OS.

**V2 API surface:**
```typescript
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  unstable_v2_prompt,
} from "@anthropic-ai/claude-agent-sdk";

// Cold boot
const session = unstable_v2_createSession({ model: "claude-opus-4-6", ...options });

// Warm wake (resume from hibernate)
const session = unstable_v2_resumeSession(sessionId, { model: "claude-opus-4-6", ...options });

// Kernel loop
await session.send(userMessage);
for await (const msg of session.stream()) {
  // process messages
}

// One-shot (simple queries)
const result = await unstable_v2_prompt("What is 2+2?", { model: "claude-opus-4-6" });
```

**Impact on verification items below:** Items marked with [V2] have changed verdicts or notes due to V2 adoption.

---

## 1. Kernel Code in FINAL-SPEC.md (Section 13)

### 1.1 `query()` function name and import path

**CONFIRMED** [V2] -- Import path unchanged, but functions differ.

Spec uses:
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
```

V1 SDK confirms this. With V2 decision, the kernel import becomes:
```typescript
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  unstable_v2_prompt,
} from "@anthropic-ai/claude-agent-sdk";
```

Same package, different entry points.

### 1.2 Streaming pattern

**WRONG** [V2] -- Spec uses blocking `await`, but V2 resolves this more cleanly than V1.

Spec assumes:
```typescript
const result = await query({ prompt: userMessage, options: {...} });
```

V1 fix would require `for await (const message of query(...))` with generator coordination.

**V2 fix is cleaner** -- separates send and stream:
```typescript
await session.send(userMessage);
for await (const msg of session.stream()) {
  if (msg.type === "assistant") {
    // process assistant response, stream to shell
  }
  if (msg.type === "result") {
    // handle final result
  }
}
```

For one-shot queries (e.g., simple routing decisions):
```typescript
const result = await unstable_v2_prompt(simpleQuery, { model: "claude-sonnet-4-5" });
console.log(result.result);
```

Message types in the stream remain the same:
- `AssistantMessage` -- complete assistant turns
- `SystemMessage` -- system events (init, compact_boundary)
- `ResultMessage` -- final result with `subtype: "success" | "error_max_turns" | "error_max_budget_usd" | "error_during_execution"`
- `stream_event` (with `includePartialMessages: true`) -- raw API events

Session ID is available from: `msg.session_id` on any received message.

### 1.3 `permissionMode: "bypassPermissions"`

**CONFIRMED** for SDK.

SDK docs list four permission modes:
- `default` -- standard behavior, triggers `canUseTool` callback
- `acceptEdits` -- auto-approves file operations (Edit, Write, mkdir, rm, mv, cp)
- `bypassPermissions` -- bypasses all permission checks
- `plan` -- planning mode, no tool execution

Note: Claude Code CLI adds two more modes not in the SDK: `dontAsk` and `delegate`. These are CLI-only.

### 1.4 The `agents` option

**PARTIAL** -- The option exists, but the SDK interface is simpler than what the spec assumes.

SDK `AgentDefinition` interface:
```typescript
interface AgentDefinition {
  description: string;       // When to use this agent
  prompt: string;            // System prompt
  tools?: string[];          // Allowed tools (inherits all if omitted)
  model?: "sonnet" | "opus" | "haiku" | "inherit";
}
```

The spec's kernel code correctly uses `description`, `prompt`, `tools` -- these are supported. But the SDK `agents` option does NOT support per-agent `permissionMode`, `maxTurns`, `memory`, `hooks`, or `disallowedTools`. Those are CLI frontmatter fields.

Spec's agent loading code is close but needs adjustment:
```typescript
// Spec (close to correct)
agents[frontmatter.name] = {
  description: frontmatter.description,
  prompt: body,
  tools: frontmatter.tools ?? ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
};
// Correct -- also pass model if specified
agents[frontmatter.name] = {
  description: frontmatter.description,
  prompt: body,
  tools: frontmatter.tools ?? ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  model: frontmatter.model ?? "inherit"
};
```

Rich features (memory, hooks, maxTurns per agent) would need to be:
- Baked into the agent's `prompt` string as instructions
- Handled at the kernel level (not by the SDK)
- Or configured via CLI markdown files in `.claude/agents/`

### 1.5 The `hooks` option

**CONFIRMED** -- hooks API is real with regex matchers.

SDK hook types (all supported):
- `PreToolUse` -- before tool execution
- `PostToolUse` -- after tool execution
- `PostToolUseFailure` -- on tool execution failure (TS only)
- `UserPromptSubmit` -- on user prompt submission
- `Stop` -- on agent stop
- `SessionStart` -- on session initialization (TS only)
- `SessionEnd` -- on session termination (TS only)
- `SubagentStart` -- on subagent initialization (TS only)
- `SubagentStop` -- on subagent completion
- `PreCompact` -- before conversation compaction
- `PermissionRequest` -- permission dialog display (TS only)
- `Notification` -- agent status messages (TS only)

Hook signature (actual):
```typescript
type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>
```

PostToolUse input structure (actual):
```typescript
type PostToolUseHookInput = BaseHookInput & {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
}
```

Hook configuration (actual):
```typescript
hooks: {
  PostToolUse: [
    { matcher: "Write|Edit", hooks: [myCallback] }  // Regex matcher
  ]
}
```

Hook return values:
```typescript
{
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  hookSpecificOutput?: {
    permissionDecision?: "allow" | "deny" | "ask";
    updatedInput?: unknown;
  }
}
```

The spec's hook configuration matches the actual API. The named hooks (`updateStateHook`, `notifyShellHook`, etc.) just need to be implemented with the correct signature above.

### 1.6 `resume: sessionId` for session resume

**CONFIRMED** [V2] -- Dedicated function instead of option flag.

V1 SDK:
```typescript
options: { resume: "session-xyz" }
```

V2 SDK (cleaner for kernel's hibernate/wake pattern):
```typescript
// Cold boot
const session = unstable_v2_createSession({ model: "claude-opus-4-6" });

// Warm wake from hibernate
const session = unstable_v2_resumeSession(storedSessionId, { model: "claude-opus-4-6" });
```

V1 also supports forking (`forkSession: true`) and continuing (`continue: true`). These are NOT yet available in V2 but are not needed for Matrix OS.

---

## 2. Sub-Agent Definitions in SUBAGENTS-INSPIRATION.md

### 2.1 Frontmatter field verification

| Field | Exists? | Where? | Notes |
|-------|---------|--------|-------|
| `name` | **CONFIRMED** | CLI frontmatter | Required. Lowercase with hyphens. |
| `description` | **CONFIRMED** | CLI + SDK | Required. Used for routing. |
| `model` | **CONFIRMED** | CLI + SDK | Values: `opus`, `sonnet`, `haiku`, `inherit`. Default: `inherit`. |
| `permissionMode` | **N/A for SDK** | CLI only | SDK supports 4 modes. CLI supports 6 (adds `dontAsk`, `delegate`). |
| `maxTurns` | **PARTIAL** | SDK: per-query option, not per-agent | SDK has `maxTurns` but it's on the `query()` options, not per-agent definition. CLI frontmatter supports it per-agent. |
| `memory` | **N/A for SDK** | CLI only | Values: `user`, `project`, `local`. Gives persistent directory across conversations. |
| `knowledge` | **WRONG** | Does not exist | The spec invents `knowledge: [app-generation, ...]`. The actual CLI field is `skills`. |
| `skills` | **N/A for SDK** | CLI only | Preloads skill content into subagent context at startup. |
| `hooks` | **PARTIAL** | Both, differently | SDK: hooks on the `query()` call, not per-agent. CLI: per-agent hooks in frontmatter. |
| `disallowedTools` | **PARTIAL** | Both, differently | SDK: `disallowedTools` on `query()` options, not per-agent. CLI: per-agent in frontmatter. |
| `tools` | **CONFIRMED** | CLI + SDK | Allowlist of tools. Inherits all if omitted. |

### 2.2 `knowledge` vs `skills`

**WRONG** -- `knowledge` is not a real field anywhere.

Spec defines:
```yaml
knowledge: [app-generation, theme-system, data-management]
```

Actual CLI field:
```yaml
skills: [skill-name-1, skill-name-2]
```

Skills load from `.claude/skills/SKILL_NAME/SKILL.md` or `~/.claude/skills/SKILL_NAME/SKILL.md`. The full content is injected into the subagent's context at startup.

The spec's concept of "knowledge files in `~/agents/knowledge/`" is a Matrix OS invention. This is fine as a custom feature but should not be confused with a SDK/CLI capability. The kernel code would need to read these files and prepend them to the agent's `prompt` string.

### 2.3 Per-agent model selection

**CONFIRMED** for both SDK and CLI.

SDK: `model` field on `AgentDefinition` supports `"sonnet" | "opus" | "haiku" | "inherit"`.
CLI: Same values in frontmatter.

The cost optimization strategy in the spec (Opus for builder, Sonnet for healer, Haiku for researcher) is supported.

### 2.4 Per-agent `permissionMode`

**N/A for SDK** -- CLI-only.

SDK's `permissionMode` is set on the `query()` call and applies to the entire session. Per-agent permission modes are a CLI frontmatter feature.

For the SDK, the kernel would need to:
- Set `bypassPermissions` globally (since the kernel trusts its own agents)
- Or implement custom permission logic via the `canUseTool` callback

### 2.5 Per-agent `maxTurns`

**PARTIAL** -- Exists as a concept but works differently.

SDK: `maxTurns` is an option on `query()`, not per-agent. It applies to the entire query session.

Since sub-agents are spawned as separate `query()` calls (via the Task tool), each sub-agent effectively gets its own `maxTurns` from its `query()` invocation. But this is set by the kernel's code, not by the agent definition.

To implement per-agent maxTurns, the kernel would pass it when creating a session for the sub-agent:
```typescript
// V2: kernel creates a session per sub-agent with its own maxTurns
const agentSession = unstable_v2_createSession({
  model: agentConfig.model ?? "claude-opus-4-6",
  maxTurns: agentConfig.maxTurns ?? 50,
});
```

### 2.6 Per-agent `memory`

**N/A for SDK** -- CLI-only feature.

CLI frontmatter supports:
- `user`: `~/.claude/agent-memory/<name>/`
- `project`: `.claude/agent-memory/<name>/`
- `local`: `.claude/agent-memory-local/<name>/`

Auto-loads first 200 lines of `MEMORY.md` into subagent's context.

For the SDK, the kernel would need to implement memory manually: read from a directory, prepend to the agent's prompt, and provide tools for the agent to write back.

---

## 3. Agent Teams Patterns in AGENT-TEAMS-INSPIRATION.md

### 3.1 Shared task list

**N/A** -- Agent Teams' shared task list is a CLI-only experimental feature.

- Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` environment variable
- Tasks stored at `~/.claude/tasks/{team-name}/`
- File locking prevents race conditions
- Three states: pending, in-progress, completed
- Dependencies supported

The spec correctly proposes a custom SQLite implementation instead. This is the right approach -- the CLI's task list is for interactive multi-instance coordination, not programmatic use.

The SDK does have a `TodoWrite` tool for per-session task tracking, but it's per-session and not shared across agents.

### 3.2 Mailbox/messaging system

**N/A** -- CLI-only feature within Agent Teams.

- Two message types: `message` (single recipient) and `broadcast` (all teammates)
- Automatic delivery
- Not available programmatically in the SDK

The spec correctly identifies this as a stretch goal with SQLite-based custom implementation.

### 3.3 Delegate mode

**N/A for SDK** -- Partially exists in CLI.

CLI: `delegate` is a `permissionMode` value that restricts to coordination-only tools. Also accessible via Shift+Tab in the CLI.

SDK: No `delegate` permission mode. The concept of "kernel only routes, doesn't execute" is a behavioral pattern to implement in code, not a SDK feature. Achievable by:
- Restricting `allowedTools` to only `Task` (for spawning) during delegation
- Or simply having the kernel's prompt instruct it to delegate

### 3.4 No nested spawning

**CONFIRMED** -- Correctly aligns with SDK behavior.

CLI docs: "Cannot spawn other subagents (no nesting)."

Enforced by not giving sub-agents the `Task` tool. This matches the spec's approach.

### 3.5 Plan-then-execute gate

**PARTIAL** -- Concept exists differently.

CLI: Plan approval workflow exists for Agent Teams. Teammate works in read-only plan mode, sends plan to lead for approval.

SDK: `plan` permission mode exists (read-only). But the approval workflow is CLI-specific.

For the SDK, implement via:
1. First query with `permissionMode: "plan"` to get the plan
2. Kernel reviews the plan
3. Second query (or resume) with normal permissions to execute

### 3.6 Quality gate hooks

**CONFIRMED** -- PostToolUse and Stop hooks work for this.

The spec's pattern of using PostToolUse for validation and Stop for completion checks maps directly to the SDK's hook system.

CLI also has `TeammateIdle` and `TaskCompleted` hooks, but those are Agent Teams features, not SDK.

---

## 4. From ANALYSIS-FEEDBACK.md Open Questions

### 4.1 How does `maxTurns` interact with `resume`?

**UNCLEAR** -- Not explicitly documented.

Evidence suggests maxTurns is per-`query()` call:
- It's passed as an option to each `query()` invocation
- Result subtype `error_max_turns` is per-call

This means: if a builder hits 80 turns and stops, resuming with `resume: sessionId` and `maxTurns: 80` likely gives another 80 turns (not cumulative). But this needs testing.

### 4.2 Token cost structure

**CONFIRMED** -- SDK provides detailed cost tracking.

Result messages include:
```typescript
{
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage: {
    [modelName: string]: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      costUSD: number;
      contextWindow: number;
    }
  }
}
```

Also supports budget caps: `maxBudgetUsd: number` option, with `error_max_budget_usd` result subtype.

The spec's cost estimates ($0.50-$5 per build) are reasonable but need live verification. The per-model breakdown in `modelUsage` supports the multi-model cost optimization strategy.

### 4.3 Auto-compaction in SDK vs CLI

**CONFIRMED** -- Auto-compaction exists in SDK.

- Triggered automatically when context grows (in streaming input mode)
- `PreCompact` hook fires before compaction
- `compact_boundary` system message indicates compaction occurred
- `compact_metadata.trigger`: `"manual" | "auto"`
- `compact_metadata.pre_tokens`: tokens before compaction
- Subagent transcripts are NOT affected by main conversation compaction

The spec assumes "auto-compacts at ~95% capacity" -- the exact threshold is not documented, but auto-compaction is confirmed for streaming mode.

Note: single-message input mode may NOT auto-compact. Streaming input mode is recommended for long sessions.

---

## 5. Additional Findings

### 5.1 System prompt configuration

**IMPORTANT** -- Default is minimal, not Claude Code.

SDK docs:
```typescript
// Minimal system prompt (default)
options: { systemPrompt: "You are a..." }

// Full Claude Code instructions (must explicitly request)
options: {
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: "Additional instructions..."
  }
}
```

The spec's kernel needs to either:
- Use `preset: "claude_code"` with `append` for the OS system prompt
- Or use a fully custom system prompt string

### 5.2 SDK `canUseTool` callback

**Not in spec, but useful.**

SDK supports a custom permission callback:
```typescript
options: {
  canUseTool: async (toolName, toolInput) => {
    // Custom logic
    return "allow" | "deny" | "ask";
  }
}
```

Permission evaluation order: Hooks > Permission rules > Permission mode > `canUseTool` callback.

This could replace per-agent `permissionMode` for SDK usage.

### 5.3 Custom tools via MCP

**Not in spec kernel code, but relevant.**

SDK supports defining custom tools:
```typescript
const customServer = createSdkMcpServer({
  name: "matrix-os-tools",
  tools: [
    tool("read_state", "Read Matrix OS state", { ... }, handler),
    tool("update_state", "Update Matrix OS state", { ... }, handler),
  ]
});

options: {
  mcpServers: { "matrix-os": customServer },
  allowedTools: ["mcp__matrix-os__read_state", ...]
}
```

This could be used to give agents Matrix OS-specific tools (read state, register process, etc.) without relying on Bash commands.

### 5.4 File checkpointing

**Not in spec, but relevant for safety.**

SDK supports file checkpointing:
```typescript
options: {
  enableFileCheckpointing: true,
  extraArgs: { "replay-user-messages": null },
  env: { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "1" }
}
```

Captures checkpoints on Write/Edit/NotebookEdit operations. Can rewind files to any checkpoint. This could replace the spec's git snapshot approach for certain use cases.

### 5.5 Structured outputs

**Not in spec, but useful for sub-agent contracts.**

SDK supports JSON schema outputs:
```typescript
options: {
  outputFormat: {
    type: "json_schema",
    schema: {
      type: "object",
      properties: { ... },
      required: [...]
    }
  }
}
```

This could enforce structured result contracts for sub-agents (e.g., builder must return `{ files: string[], entryPoint: string, port: number }`).

---

## 6. Critical Fixes Required

### 6.1 MUST FIX: Rewrite kernel to V2 session pattern [V2]

Replace all `query()` calls with V2 session pattern:

```typescript
// Kernel cold boot
const session = unstable_v2_createSession({
  model: "claude-opus-4-6",
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  systemPrompt: { type: "preset", preset: "claude_code", append: osSystemPrompt },
  agents: allAgents,
  hooks: { PostToolUse: [...], Stop: [...] },
  mcpServers: { "matrix-os": matrixOsTools },
});

// Kernel warm wake
const session = unstable_v2_resumeSession(storedSessionId, { ...sameOptions });

// Kernel loop
await session.send(userMessage);
let sessionId: string | undefined;
for await (const msg of session.stream()) {
  sessionId = msg.session_id;
  if (msg.type === "assistant") {
    // Stream to shell UI
  }
  if (msg.type === "result") {
    // Process final result, update state
  }
}

// Save session ID for hibernate
await saveSessionId(sessionId);
session.close();
```

### 6.2 MUST FIX: `knowledge` field does not exist

Replace `knowledge: [...]` in agent definitions with either:
- `skills: [...]` (if using CLI frontmatter) -- loads from `.claude/skills/`
- Or manually prepend knowledge content to the agent's `prompt` string (if using SDK)

### 6.3 SHOULD FIX: Distinguish SDK vs CLI agent features

The spec conflates SDK agent definitions (simple: description, prompt, tools, model) with CLI frontmatter (rich: adds permissionMode, maxTurns, memory, hooks, disallowedTools).

For SDK usage, the kernel must handle rich features itself:
- `permissionMode` per agent: use global `bypassPermissions` or `canUseTool` callback
- `maxTurns` per agent: pass to each `query()` call when spawning
- `memory` per agent: read/write files manually, prepend to prompt
- `hooks` per agent: set on `query()` call, not on agent definition

### 6.4 SHOULD FIX: Use `systemPrompt` preset

Add to kernel query options:
```typescript
systemPrompt: {
  type: "preset",
  preset: "claude_code",
  append: osSystemPrompt  // Matrix OS specific instructions
}
```

### 6.5 NICE TO HAVE: Consider custom MCP tools

Instead of relying on Bash for state management, define Matrix OS tools via `createSdkMcpServer`. This gives agents typed, safe tools instead of raw shell access.

### 6.6 NICE TO HAVE: Consider structured outputs

Use `outputFormat` for sub-agent result contracts. Forces structured responses instead of hoping the agent writes results to the right files.

---

## Summary Table

| # | Assumption | Verdict | Action Required |
|---|-----------|---------|-----------------|
| 1.1 | `query()` import from `@anthropic-ai/claude-agent-sdk` | CONFIRMED [V2] | Use V2 imports (`unstable_v2_createSession`, etc.) |
| 1.2 | Blocking `await query()` | **WRONG** [V2] | Use V2 `send()` / `stream()` pattern |
| 1.3 | `permissionMode: "bypassPermissions"` | CONFIRMED | None |
| 1.4 | `agents` option with `{description, prompt, tools}` | PARTIAL | SDK only supports 4 fields, not rich frontmatter |
| 1.5 | `hooks` with regex matchers | CONFIRMED | Implement hook functions with correct signature |
| 1.6 | `resume: sessionId` | CONFIRMED [V2] | Use `unstable_v2_resumeSession()` |
| 2.1 | `model` per sub-agent | CONFIRMED | None |
| 2.2 | `permissionMode` per sub-agent | N/A (SDK) | CLI only. Use global mode or `canUseTool` in SDK |
| 2.3 | `maxTurns` per sub-agent | PARTIAL | Per-session, not per-agent definition |
| 2.4 | `memory` per sub-agent | N/A (SDK) | CLI only. Implement manually in SDK |
| 2.5 | `knowledge` field | **WRONG** | Does not exist. Use `skills` (CLI) or prompt injection |
| 2.6 | `skills` per sub-agent | N/A (SDK) | CLI only. Manually prepend in SDK |
| 2.7 | `hooks` per sub-agent | PARTIAL | SDK: per-session. CLI: per-agent |
| 2.8 | `disallowedTools` per sub-agent | PARTIAL | SDK: per-session. CLI: per-agent |
| 3.1 | Shared task list | N/A | CLI-only. Custom MCP tools + SQLite (see Section 7) |
| 3.2 | Mailbox/messaging | N/A | CLI-only. Custom MCP tools + SQLite (see Section 7) |
| 3.3 | Delegate mode | N/A (SDK) | Implement via tool restrictions |
| 3.4 | No nested spawning | CONFIRMED | Omit Task tool from sub-agents |
| 3.5 | Plan-then-execute | PARTIAL | Concept exists, workflow differs |
| 3.6 | Quality gate hooks | CONFIRMED | PostToolUse + Stop hooks work |
| 4.1 | maxTurns + resume interaction | UNCLEAR [V2] | V2 uses `resumeSession` -- likely resets per-session, needs testing |
| 4.2 | Token cost tracking | CONFIRMED | `total_cost_usd` + `modelUsage` |
| 4.3 | Auto-compaction | CONFIRMED | Exists in streaming mode, threshold undocumented |

---

## 7. IPC Layer: Task List + Messaging via Custom MCP Tools

Agent Teams' shared task list and mailbox messaging are CLI-only features. Matrix OS needs these capabilities programmatically. The solution: custom MCP tools backed by SQLite, exposed to agents as first-class tools.

### 7.1 Architecture

```
Kernel <-> SQLite DB <-> MCP Server (in-process) <-> Agents
```

The kernel creates an in-process MCP server using `createSdkMcpServer()`. This server exposes task and messaging operations as tools. Agents call these tools naturally -- they appear alongside Read, Write, Bash, etc.

### 7.2 SQLite Schema

```sql
-- Task list (replaces processes.json)
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,              -- 'build', 'heal', 'research', 'evolve'
  status TEXT DEFAULT 'pending',   -- 'pending', 'in_progress', 'completed', 'failed', 'cancelling'
  assigned_to TEXT,                -- agent name or null (unassigned)
  depends_on TEXT,                 -- JSON array of task IDs
  input TEXT NOT NULL,             -- JSON: { request, context, files... }
  output TEXT,                     -- JSON: { files, entryPoint, port, errors... }
  priority INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  completed_at INTEGER
);

-- Message queue (agent-to-kernel and kernel-to-agent)
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,        -- agent name or 'kernel'
  to_agent TEXT NOT NULL,          -- agent name, 'kernel', or 'broadcast'
  content TEXT NOT NULL,           -- freeform text or JSON
  read INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Indexes for common queries
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX idx_messages_to ON messages(to_agent, read);
```

### 7.3 MCP Tool Definitions

These tools are defined using `createSdkMcpServer` and given to agents via `mcpServers` + `allowedTools`:

```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const matrixOsIpc = createSdkMcpServer({
  name: "matrix-os-ipc",
  tools: [
    // --- Task tools ---
    tool("list_tasks", "List tasks, optionally filtered by status or assignee", {
      status: z.enum(["pending", "in_progress", "completed", "failed"]).optional(),
      assigned_to: z.string().optional(),
    }, async (args) => { /* query SQLite, return task list */ }),

    tool("claim_task", "Claim an unassigned pending task for this agent", {
      task_id: z.string(),
    }, async (args) => { /* atomic UPDATE ... SET assigned_to, status='in_progress' WHERE status='pending' */ }),

    tool("complete_task", "Mark a task as completed with output", {
      task_id: z.string(),
      output: z.string(),  // JSON string with result data
    }, async (args) => { /* UPDATE status='completed', unblock dependents */ }),

    tool("fail_task", "Mark a task as failed with error details", {
      task_id: z.string(),
      error: z.string(),
    }, async (args) => { /* UPDATE status='failed' */ }),

    // --- Message tools ---
    tool("send_message", "Send a message to another agent or the kernel", {
      to: z.string(),       // agent name, 'kernel', or 'broadcast'
      content: z.string(),
    }, async (args) => { /* INSERT into messages */ }),

    tool("read_messages", "Read unread messages for this agent", {},
      async () => { /* SELECT ... WHERE to_agent=self AND read=0, mark as read */ }),

    // --- State tools ---
    tool("read_state", "Read the current Matrix OS state summary", {},
      async () => { /* generate state.md from SQLite, return content */ }),
  ],
});
```

### 7.4 Wiring into the Kernel

```typescript
const session = unstable_v2_createSession({
  model: "claude-opus-4-6",
  mcpServers: {
    "matrix-os-ipc": matrixOsIpc,
  },
  allowedTools: [
    // Standard tools
    "Read", "Write", "Edit", "Bash", "Glob", "Grep", "Task",
    // IPC tools
    "mcp__matrix-os-ipc__list_tasks",
    "mcp__matrix-os-ipc__claim_task",
    "mcp__matrix-os-ipc__complete_task",
    "mcp__matrix-os-ipc__fail_task",
    "mcp__matrix-os-ipc__send_message",
    "mcp__matrix-os-ipc__read_messages",
    "mcp__matrix-os-ipc__read_state",
  ],
  agents: allAgents,
  // ...
});
```

Sub-agents get a subset of IPC tools based on their role:
- **Builder**: `claim_task`, `complete_task`, `fail_task`, `send_message` (to report progress)
- **Healer**: `claim_task`, `complete_task`, `fail_task`, `read_state` (to diagnose)
- **Researcher**: `read_messages`, `send_message` (read-only, reports findings)
- **Kernel**: all tools (creates tasks, reads messages, manages state)

### 7.5 Task Lifecycle

```
User request
    |
    v
Kernel creates task (INSERT into tasks)
    |
    v
Kernel spawns sub-agent with task details in prompt
    |
    v
Sub-agent calls claim_task (atomic, prevents races)
    |
    v
Sub-agent works... (calls send_message for progress updates)
    |
    v
Sub-agent calls complete_task with output JSON
    |
    v
Kernel's SubagentStop hook fires
    |
    v
Kernel reads task output, updates state, unblocks dependents
```

### 7.6 Advantages Over CLI Agent Teams

| | CLI Agent Teams | Matrix OS IPC Layer |
|---|---|---|
| **Backing store** | Filesystem (flat files + file locking) | SQLite (atomic transactions, WAL mode) |
| **Query capability** | Read entire task list | SQL queries with filters, joins |
| **Web API** | None (CLI-only) | SQLite readable from Express/gateway for shell UI |
| **Extensibility** | Fixed schema | Add columns, tables as needed |
| **Concurrency** | File locking | Row-level locking via SQLite |
| **Agent interface** | Implicit (agent teams protocol) | Explicit MCP tools (typed, discoverable) |

### 7.7 Design Decisions for the Builder

This IPC layer is a good candidate for building yourself. Key decisions:

1. **Task claiming strategy**: First-come-first-serve (sub-agent picks from queue) vs kernel-assigned (kernel decides who gets what)?
2. **Message delivery**: Polling (agent calls `read_messages` periodically) vs notification (kernel injects messages via hook)?
3. **Task output format**: Freeform text vs structured JSON schema per task type?
4. **Dependency resolution**: Eager (unblock as soon as dep completes) vs lazy (check deps when claiming)?
5. **Failure handling**: Auto-retry (kernel re-queues failed tasks) vs escalate (kernel decides)?
