# Inspiration: Claude Code Agent Teams

Source: Claude Code docs on orchestrating teams of Claude Code sessions (experimental feature).

This documents patterns from Claude Code's Agent Teams that directly apply to Matrix OS's multiprocessing and sub-agent architecture.

---

## What Agent Teams Are

Claude Code Agent Teams coordinate multiple independent Claude Code instances. One session acts as "team lead" (coordinator), spawning "teammates" (independent workers). Each teammate has its own context window and can communicate with other teammates directly.

Key components:
- **Team lead**: creates team, spawns teammates, coordinates work
- **Teammates**: separate Claude instances with own context
- **Shared task list**: work items that teammates claim and complete, with dependencies
- **Mailbox**: direct agent-to-agent messaging

---

## Patterns to Adopt

### 1. Shared Task List as Coordination Primitive

Agent Teams use a shared task list with dependencies, claiming, and status tracking as the primary coordination mechanism between agents. Tasks have three states: pending, in_progress, completed. Tasks can depend on other tasks -- a pending task with unresolved dependencies can't be claimed until those dependencies complete.

**For Matrix OS:** Replace `processes.json` with a SQLite-backed task queue. When the kernel spawns a builder, it creates a task. The builder claims it. When builder completes sub-steps, dependent tasks unblock automatically.

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,          -- 'build', 'heal', 'research', 'evolve'
  status TEXT DEFAULT 'pending', -- 'pending', 'in_progress', 'completed', 'failed'
  assigned_to TEXT,             -- kernel instance or sub-agent ID
  depends_on TEXT,              -- JSON array of task IDs
  input TEXT,                   -- JSON: user request, context
  output TEXT,                  -- JSON: result files, status
  created_at INTEGER,
  claimed_at INTEGER,
  completed_at INTEGER
);
```

This is better than file-based IPC because:
- Atomic claiming (SQLite row lock prevents race conditions)
- Built-in dependency graph
- Status tracking without polling files
- Works with concurrent kernel instances out of the box

### 2. Plan-Then-Execute Safety Gate

Agent Teams support requiring plan approval before teammates implement. The teammate works in read-only mode, produces a plan, sends it to the lead for review. Lead approves or rejects with feedback. Only after approval does the teammate start writing code.

**For Matrix OS:** Critical for two agents:

**Evolver agent** (modifies OS source):
- Evolver proposes a plan: which files to change, what the diff looks like, why
- Kernel reviews the plan (or prompts user for approval)
- Only after approval does the evolver write changes
- If rejected, evolver revises and resubmits

**Builder agent** (generates apps):
- For complex multi-file apps, builder proposes structure first
- Kernel validates against existing modules (dependency conflicts? port collisions?)
- Builder proceeds only after approval

This adds latency but prevents the most dangerous failure mode: an agent making a bad change that breaks the system.

### 3. Delegate Mode

Agent Teams have a "delegate mode" where the lead is restricted to coordination-only tools: spawning, messaging, task management. It can't implement anything directly.

**For Matrix OS:** The smart kernel should be able to switch to delegate mode when multiple sub-agents are running. In delegate mode, the kernel:
- Only routes requests and manages tasks
- Doesn't execute tools itself (no file writes, no bash)
- Monitors sub-agent progress
- Synthesizes results when sub-agents complete

This prevents the kernel from competing with sub-agents for the same files. In normal mode (single request, no active sub-agents), the kernel handles things directly as designed.

### 4. No Nested Teams (Anti-Recursion)

Agent Teams explicitly prevent teammates from spawning their own teams. Only the lead can manage the team. This prevents infinite recursion.

**For Matrix OS:** Sub-agents must NOT be able to spawn other sub-agents. Enforce this by:
- Sub-agents don't get the `Task` tool in their tool list
- Only the kernel has the ability to spawn sub-agents
- This is already implied in the spec but should be an explicit hard rule

Exception: the kernel CAN spawn multiple sub-agents simultaneously (e.g., builder + researcher in parallel). But those sub-agents can't spawn further agents.

### 5. Quality Gate Hooks

Agent Teams have two hooks for quality enforcement:
- `TeammateIdle`: runs when a teammate finishes. Exit code 2 sends feedback and keeps them working.
- `TaskCompleted`: runs when a task is marked complete. Exit code 2 prevents completion.

**For Matrix OS:** Use Agent SDK's PostToolUse hooks as quality gates:

```typescript
hooks: {
  PostToolUse: [{
    matcher: "Write|Edit",
    hooks: [async (input) => {
      // After builder writes files, validate them
      // Run type-check, lint, basic tests
      // If validation fails, reject and send feedback
    }]
  }],
  Stop: [{
    hooks: [async (input) => {
      // When sub-agent completes, verify output
      // Check that expected files exist
      // Run health check on generated app
      // If incomplete, could restart or flag
    }]
  }]
}
```

### 6. Direct Agent-to-Agent Messaging (Mailbox)

Agent Teams have a mailbox system where teammates can message each other directly, not just through the lead. Messages arrive automatically.

**For Matrix OS:** Implement via SQLite message queue:

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,    -- or 'broadcast' for all
  content TEXT NOT NULL,
  read INTEGER DEFAULT 0,
  created_at INTEGER
);
```

Use cases:
- Builder discovers it needs data from an existing module -> messages the kernel to check
- Healer finds a recurring issue -> messages the kernel suggesting a permanent fix
- Two concurrent builders working on related modules -> coordinate shared dependencies

For the hackathon, this is a stretch goal. File-based IPC (agents write results to files, kernel reads them) is simpler and sufficient. But the message queue pattern is cleaner for production.

### 7. Independent Context per Agent

Each teammate loads project context (CLAUDE.md, MCP servers, skills) but NOT the lead's conversation history. They get a spawn prompt with task-specific details.

**For Matrix OS:** Already in the spec. Sub-agents get:
- The OS system prompt (knowledge files)
- Task-specific instructions (what to build/heal/research)
- NO conversation history from the kernel

This is the right design. Sub-agents should start clean with just enough context for their task. Carrying the kernel's full conversation history would burn tokens on irrelevant context.

### 8. Graceful Shutdown Protocol

Agent Teams have a shutdown protocol: lead requests shutdown, teammate can approve or reject. If rejected, the teammate explains why (e.g., "I'm in the middle of writing tests").

**For Matrix OS:** When the kernel needs to stop a sub-agent:
1. Send a cancellation signal (set task status to 'cancelling' in SQLite)
2. Sub-agent checks task status periodically (or via hook)
3. Sub-agent finishes current atomic operation (don't interrupt mid-file-write)
4. Sub-agent writes partial results to output files
5. Sub-agent exits cleanly

Forceful termination (process.kill) as a fallback if graceful shutdown times out (30s).

---

## What NOT to Adopt

### Split-pane display mode
Agent Teams support tmux/iTerm2 split panes for visual display. Matrix OS doesn't need this -- the web shell already provides the visual layer. Sub-agents are invisible background workers.

### Human-in-the-loop for every teammate
Agent Teams allow users to message any teammate directly. Matrix OS sub-agents should be autonomous. The user talks to the kernel only. The kernel manages sub-agents.

### Session resumption for sub-agents
Agent Teams note that session resume doesn't work well for teammates. Matrix OS sub-agents are ephemeral by design -- they do a task and exit. No need for session resume on sub-agents. Only the main kernel session resumes.

---

## Mapping to Matrix OS Architecture

| Agent Teams Concept | Matrix OS Equivalent | Implementation |
|-------------------|---------------------|----------------|
| Team lead | Smart Kernel (main agent) | The `query()` call with full tool access |
| Teammates | Sub-agents (builder, healer, etc.) | Spawned via `Task` tool |
| Shared task list | SQLite `tasks` table | Replaces processes.json |
| Mailbox | SQLite `messages` table | Stretch goal, file IPC for hackathon |
| Task dependencies | `depends_on` column | Auto-unblock when deps complete |
| Plan approval | Plan-then-execute gate | Required for evolver, optional for builder |
| Delegate mode | Coordination-only mode | Kernel switches when sub-agents active |
| No nested teams | No sub-agent spawning sub-agents | Hard rule, enforce via tool restrictions |
| Quality gate hooks | PostToolUse + Stop hooks | Validate outputs before marking complete |
| TeammateIdle | Sub-agent completion | Kernel reads result files, updates state |
| Graceful shutdown | Cancellation protocol | Task status -> 'cancelling', timeout -> kill |

---

## Impact on Specs

These patterns suggest the following changes to FINAL-SPEC.md:

1. **Replace processes.json with SQLite tasks table** -- already decided in ANALYSIS-FEEDBACK.md
2. **Add plan-then-execute gate for evolver agent** -- new safety mechanism
3. **Enforce no-nested-spawning rule** -- explicit in sub-agent tool restrictions
4. **Add delegate mode concept** -- kernel behavior when sub-agents are active
5. **Quality gate hooks on sub-agent outputs** -- validate before accepting results

### Open Questions

- [ ] **Q: Should the plan-then-execute gate be mandatory for ALL sub-agents, or just evolver?** Builder could benefit from it for complex multi-file apps, but it adds latency. Maybe optional based on complexity.
- [ ] **Q: Should delegate mode be automatic or manual?** Automatic: kernel enters delegate mode whenever it has active sub-agents. Manual: kernel decides based on load. Automatic is simpler.
- [ ] **Q: How does the kernel detect that a sub-agent has completed?** Options: (a) poll the tasks table, (b) sub-agent writes a completion file and kernel watches with chokidar, (c) Agent SDK's Stop hook notifies kernel. Need to verify what the SDK supports.
- [ ] **Q: Should there be a max number of concurrent sub-agents?** Agent Teams docs warn about token cost scaling with team size. 3-4 concurrent sub-agents seems reasonable for both cost and coordination complexity.
