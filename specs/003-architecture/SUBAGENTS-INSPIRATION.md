# Inspiration: Claude Code Custom Subagents

Source: Claude Code docs on creating custom subagents.

This documents patterns from Claude Code's subagent system that directly apply to Matrix OS's sub-agent architecture and how they validate, extend, or challenge our current spec.

---

## Validation: Our Spec Already Has These Right

### 1. Markdown Files with YAML Frontmatter

Our custom agent definition format in `~/agents/custom/*.md` is exactly how Claude Code defines subagents. Same pattern: YAML frontmatter for metadata, markdown body for the system prompt.

**Our spec:**
```markdown
---
name: data-analyst
description: Analyzes datasets, generates visualizations
tools: [Read, Write, Edit, Bash, Glob, Grep]
knowledge: [data-management.md]
---
You are a data analysis specialist for Matrix OS.
```

**Claude Code's format:**
```markdown
---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
---
You are a senior code reviewer...
```

Nearly identical. This validates our design. The format is proven and works.

### 2. No Nested Spawning

Claude Code explicitly states: "Subagents cannot spawn other subagents." Already in our spec as a hard rule. Confirmed correct.

### 3. Tool Restrictions per Sub-Agent

Our spec has `tools` in the frontmatter. Claude Code has the same, plus `disallowedTools` as a denylist. Both approaches work.

### 4. Hooks per Sub-Agent

Our spec has PostToolUse hooks on the kernel. Claude Code allows hooks defined per subagent in frontmatter (PreToolUse, PostToolUse, Stop). Same pattern, more granular.

---

## New Patterns to Adopt

### 5. Model Selection per Sub-Agent (Cost Optimization)

**This is the biggest insight we missed.**

Claude Code supports `model` field per subagent: `opus`, `sonnet`, `haiku`, or `inherit`. Not every sub-agent needs Opus 4.6. This dramatically affects token economics.

**For Matrix OS:**

| Sub-Agent | Model | Why |
|-----------|-------|-----|
| **Kernel** (smart router) | Opus | Needs full reasoning for routing decisions, direct handling |
| **Builder** | Opus | Complex code generation requires best reasoning |
| **Healer** | Sonnet | Diagnosis + patching is moderately complex |
| **Researcher** | Haiku | Just searching, reading, summarizing -- fast and cheap |
| **Deployer** | Sonnet | Follows deployment scripts, moderate reasoning |
| **Evolver** | Opus | Modifying OS source requires best reasoning |
| **Custom (simple)** | Haiku | User-defined simple tasks |
| **Custom (complex)** | Sonnet/Opus | User-defined complex tasks |

**Impact on token economics (from ANALYSIS-FEEDBACK.md):**

| Model | Input cost (per 1M tokens) | Output cost | Relative cost |
|-------|---------------------------|-------------|---------------|
| Opus 4.6 | ~$15 | ~$75 | 1x (baseline) |
| Sonnet 4.5 | ~$3 | ~$15 | ~5x cheaper |
| Haiku 4.5 | ~$0.80 | ~$4 | ~19x cheaper |

Using Haiku for researcher and Sonnet for healer/deployer could cut overall costs by 50-70% compared to running everything on Opus.

**Add to custom agent frontmatter:**
```yaml
---
name: data-analyst
description: Analyzes datasets
tools: [Read, Write, Bash, Glob, Grep]
model: sonnet  # NEW: model selection
---
```

### 6. Permission Modes per Sub-Agent

Claude Code supports per-subagent permission modes:

| Mode | Behavior |
|------|----------|
| `default` | Standard permission checking with prompts |
| `acceptEdits` | Auto-accept file edits |
| `dontAsk` | Auto-deny permission prompts |
| `bypassPermissions` | Skip all permission checks |
| `plan` | Read-only exploration mode |

**For Matrix OS:**

| Sub-Agent | Permission Mode | Why |
|-----------|----------------|-----|
| **Builder** | `bypassPermissions` | Needs to create files freely in ~/apps/ |
| **Healer** | `acceptEdits` | Can edit existing files, but should be logged |
| **Researcher** | `plan` | Read-only, never writes anything |
| **Evolver** | `default` | Must get kernel/user approval for every change |
| **Deployer** | `bypassPermissions` | Needs to run deploy commands freely |

The `plan` mode for researcher is elegant -- it physically can't write, so it's safe to let it explore freely. The evolver using `default` mode means it must get approval for every file modification, which is the plan-then-execute safety gate from AGENT-TEAMS-INSPIRATION.md.

**Add to custom agent frontmatter:**
```yaml
---
name: researcher
description: Researches topics across web and codebase
tools: [Read, Grep, Glob, WebSearch, WebFetch]
model: haiku
permissionMode: plan  # NEW: read-only mode
---
```

### 7. maxTurns (Hard Context Budget)

Claude Code supports `maxTurns` -- a hard limit on how many agentic turns a subagent can take before being forced to stop.

**For Matrix OS:** This is the "hard timeout" the systems architect recommended. Sets an upper bound on how long (and how expensive) a sub-agent can be.

| Sub-Agent | maxTurns | Rationale |
|-----------|----------|-----------|
| **Builder** (simple app) | 30 | Single-file HTML app shouldn't need more |
| **Builder** (complex app) | 80 | Multi-file app with deps needs more room |
| **Healer** | 20 | If you can't diagnose in 20 turns, escalate |
| **Researcher** | 15 | Search, read a few files, summarize |
| **Evolver** | 40 | Careful modifications with validation |

**Add to custom agent frontmatter:**
```yaml
---
name: healer
description: Diagnoses and fixes broken applications
tools: [Read, Edit, Bash, Grep]
model: sonnet
maxTurns: 20  # NEW: hard limit
---
```

### 8. Persistent Memory per Sub-Agent

Claude Code supports a `memory` field that gives subagents a persistent directory across conversations. The subagent can write learnings to files that survive session boundaries.

Scopes: `user` (all projects), `project` (this project), `local` (this project, not version-controlled).

Auto-loads first 200 lines of `MEMORY.md` into the subagent's context.

**For Matrix OS:** This is powerful for long-running OS instances. Sub-agents learn over time:

- **Healer memory:** "Last 5 healing events: JWT token issues in auth module (3x), CSS z-index conflict in dashboard (1x), missing env var in deploy (1x). Common root cause: missing error boundaries in React components."
- **Builder memory:** "User prefers Tailwind CSS. Always include dark mode. Use SQLite over Postgres for local apps. Last 10 apps: 8 used React, 2 used vanilla HTML."
- **Researcher memory:** "User's preferred documentation sources: MDN, React docs, Tailwind docs. Avoid W3Schools."

**Implementation for Matrix OS:**
```
~/agents/memory/
  builder/
    MEMORY.md          # Builder's learned patterns
  healer/
    MEMORY.md          # Healer's learned patterns
  researcher/
    MEMORY.md          # Researcher's learned patterns
  custom-data-analyst/
    MEMORY.md          # Custom agent's learned patterns
```

The first 200 lines of each agent's `MEMORY.md` gets injected into that agent's system prompt on every spawn. Agents update their own MEMORY.md after completing tasks.

**Add to custom agent frontmatter:**
```yaml
---
name: builder
description: Generates apps from natural language
memory: project  # NEW: persistent cross-session learning
---
```

### 9. Foreground vs Background Execution

Claude Code distinguishes:
- **Foreground subagents**: block the main conversation, can ask clarifying questions
- **Background subagents**: run concurrently, pre-approve permissions, auto-deny anything not pre-approved, can't ask questions

**For Matrix OS:** This maps to our multiprocessing model:

- **Foreground (synchronous):** "What's the weather?" -- kernel handles directly, user waits
- **Background (async):** "Build me a CRM" -- kernel spawns builder in background, user continues chatting

The pre-approval pattern is important: before launching a background builder, the kernel grants it all the permissions it will need (file write, bash, etc.). The builder never needs to ask for permission mid-execution.

### 10. Resume = Our Swap Mechanism

Claude Code's subagent resume: "Each subagent invocation creates a new instance with fresh context. To continue an existing subagent's work, ask Claude to resume it. Resumed subagents retain their full conversation history."

**For Matrix OS:** This IS our swap mechanism from the computer architecture metaphor. A sub-agent can:
1. Do partial work
2. Get "swapped out" (session saved to disk as JSONL)
3. Later get "swapped back in" (resumed with full context)

This is especially useful for long-running builders. User asks "Build me a CRM", builder starts, user says "also add a pipeline view" -- the builder resumes with its full context of the CRM build, rather than starting from scratch.

### 11. Task(agent_type) Restrictions

Claude Code lets the main agent restrict which subagent types it can spawn:
```yaml
tools: Task(worker, researcher), Read, Bash
```

**For Matrix OS:** The kernel could restrict itself based on context:
- During normal operation: can spawn any agent
- During self-healing: only healer and researcher
- During evolution: only evolver (prevent accidental spawning during sensitive operations)

### 12. disallowedTools (Denylist)

In addition to `tools` (allowlist), Claude Code has `disallowedTools` (denylist). Useful for "everything except X" patterns.

**For Matrix OS:** Cleaner way to define researcher:
```yaml
---
name: researcher
disallowedTools: [Write, Edit, Bash]  # Can use everything else
---
```

Instead of listing every allowed tool, just deny the dangerous ones.

### 13. Skills Preloading

Claude Code's `skills` field injects skill content into the subagent's context at startup. The subagent doesn't inherit skills from the parent -- you list them explicitly.

**For Matrix OS:** This is our `knowledge` frontmatter field. Each sub-agent gets specific knowledge files injected:

```yaml
---
name: builder
skills:
  - app-generation       # How to generate apps
  - theme-system         # How themes work
  - data-management      # How to structure data files
---
```

The builder gets app generation knowledge. The healer gets healing strategies. The researcher gets nothing extra (it discovers what it needs).

### 14. Auto-Compaction

Claude Code auto-compacts subagent context at ~95% capacity. Configurable via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.

**For Matrix OS:** Our "virtual memory" concept. When a sub-agent's context fills up, it auto-compacts (summarizes earlier conversation, drops tool results). This extends the effective working memory of long-running agents like the builder.

---

## Updated Custom Agent Schema

Based on all patterns from both Agent Teams and Subagents docs:

```yaml
---
# Required
name: agent-name              # Unique identifier, lowercase with hyphens
description: When to use this agent  # Claude uses this for routing

# Optional - Capability control
tools: [Read, Write, Edit, Bash, Glob, Grep]  # Allowlist (inherits all if omitted)
disallowedTools: []            # Denylist (removed from inherited/specified)
permissionMode: default        # default | acceptEdits | dontAsk | bypassPermissions | plan

# Optional - Resource control
model: opus                    # opus | sonnet | haiku | inherit
maxTurns: 50                   # Hard limit on agentic turns

# Optional - Knowledge
knowledge: []                  # Knowledge files to preload from ~/agents/knowledge/
memory: project                # user | project | local (persistent cross-session learning)

# Optional - Hooks
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate.sh"
  PostToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "./scripts/lint.sh"
---

[System prompt in markdown body]
```

---

## Core Sub-Agent Definitions (Revised)

### Builder
```yaml
---
name: builder
description: Generates applications and modules from natural language descriptions. Use for any "build me", "create", "make" request.
tools: [Read, Write, Edit, Bash, Glob, Grep]
model: opus
permissionMode: bypassPermissions
maxTurns: 80
memory: project
knowledge: [app-generation, theme-system, data-management]
---
```

### Healer
```yaml
---
name: healer
description: Diagnoses and repairs broken applications. Use when errors are detected or user reports something broken.
tools: [Read, Edit, Bash, Grep, Glob]
model: sonnet
permissionMode: acceptEdits
maxTurns: 20
memory: project
knowledge: [healing-strategies]
---
```

### Researcher
```yaml
---
name: researcher
description: Researches topics, explores codebases, gathers information. Use when the kernel needs information before making a decision.
disallowedTools: [Write, Edit]
model: haiku
permissionMode: plan
maxTurns: 15
---
```

### Deployer
```yaml
---
name: deployer
description: Deploys applications to hosting services. Use for any deploy, publish, or ship request.
tools: [Read, Bash, Glob]
model: sonnet
permissionMode: bypassPermissions
maxTurns: 30
knowledge: [deployment]
---
```

### Evolver
```yaml
---
name: evolver
description: Modifies Matrix OS source code to add features or improve the system. Use only when user explicitly asks to change the OS itself.
tools: [Read, Write, Edit, Bash, Glob, Grep]
model: opus
permissionMode: default
maxTurns: 40
memory: project
knowledge: [self-evolution]
hooks:
  PreToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "./scripts/git-snapshot.sh"
---
```

---

## Open Questions

- [ ] **Q: Should the kernel itself use a different model for different operations?** E.g., use Haiku for simple routing ("is this a build request or a question?"), Sonnet for moderate tasks, Opus only for complex reasoning. This would require the kernel to be multi-model, which the Agent SDK may not support natively.
- [ ] **Q: How does `maxTurns` interact with `resume`?** If a builder hits 80 turns and stops, then gets resumed, does it get another 80? Or is the limit per-session? Need to verify with SDK docs.
- [ ] **Q: Should persistent memory be opt-in or opt-out for custom agents?** Default to `memory: project` for all agents, or require explicit opt-in? Memory adds context overhead (up to 200 lines of MEMORY.md per agent).
- [ ] **Q: What happens when a background sub-agent fails?** Claude Code says "you can resume it in the foreground." For Matrix OS, should the kernel automatically retry, escalate to user, or just log the failure?
- [ ] **Q: Should we support `disallowedTools` or just `tools` for the hackathon?** Both is cleaner, but `tools` alone is simpler to implement. Denylist is more future-proof.
