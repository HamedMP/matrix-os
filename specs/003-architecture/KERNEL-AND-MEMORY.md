# Matrix OS -- Kernel and Memory Architecture

## The Core Metaphor

Matrix OS treats the Claude Agent SDK as a literal operating system kernel. The metaphor isn't decorative -- it maps precisely to real computer architecture:

| Computer Architecture | Matrix OS Equivalent |
|----------------------|---------------------|
| CPU | Claude Opus 4.6 (reasoning engine) |
| RAM | Agent SDK context window (working memory) |
| CPU Cores | Concurrent kernel instances (parallel query() calls) |
| Kernel | Main agent with smart routing + full tool access |
| Processes | Sub-agents spawned via Task tool |
| Process Table | ~/system/processes.json |
| Virtual Memory | Demand-paged knowledge files |
| Disk | File system (~/apps, ~/data, ~/system, ~/agents) |
| Swap | Session resume (hibernate/wake) |
| System Calls | Agent SDK tools (Read, Write, Edit, Bash, etc.) |
| IPC | File system (agents coordinate through shared files) |
| BIOS/Firmware | Static system prompt (core identity, never changes) |
| Device Drivers | MCP servers (external service connections) |

---

## Memory Hierarchy

The agent's context window is finite, just like RAM. Matrix OS manages this through a strict memory hierarchy, where each level is larger but slower to access:

```
┌───────────────────────────────────────────────────────────┐
│ REGISTERS  (~2K tokens)                                    │
│ Always in system prompt. Never evicted.                    │
│                                                            │
│ - OS identity and personality                              │
│ - File system conventions (where things go)                │
│ - Routing rules (when to dispatch, when to handle)         │
│ - Sub-agent definitions (what each can do)                 │
│ - Safety constraints                                       │
├───────────────────────────────────────────────────────────┤
│ L1 CACHE  (~3-4K tokens)                                   │
│ Injected into system prompt. Rebuilt every interaction.     │
│                                                            │
│ - ~/system/state.md  (live OS state summary)               │
│ - ~/system/modules.json  (module index: names, types,      │
│   ports, status -- compact)                                │
│ - ~/system/processes.json  (active kernel instances and     │
│   their current tasks)                                     │
│ - Last 10 lines of ~/system/activity.log                   │
│ - Knowledge table of contents (names + one-line summaries) │
├───────────────────────────────────────────────────────────┤
│ L2 CACHE  (conversation context, grows during session)     │
│                                                            │
│ - Current conversation turns with the user                 │
│ - Sub-agent result summaries (not full output)             │
│ - Recently read file contents (cached by the SDK)          │
│ - Auto-compressed by SDK when approaching context limit    │
├───────────────────────────────────────────────────────────┤
│ MAIN MEMORY  (files on disk, read via tools, instant)      │
│                                                            │
│ - ~/agents/knowledge/*.md  (full knowledge files,          │
│   loaded on demand when the agent needs them)              │
│ - ~/modules/*/manifest.json  (module details)              │
│ - ~/system/*.json  (theme, layout, config, providers)      │
│ - ~/agents/memory/*.md  (long-term observations)           │
├───────────────────────────────────────────────────────────┤
│ DISK  (files on disk, larger payloads)                     │
│                                                            │
│ - ~/modules/*/src/**  (full source code of modules)        │
│ - ~/apps/*.html  (generated HTML applications)             │
│ - ~/data/**  (user data, databases)                        │
│ - ~/sessions/*.jsonl  (conversation archives)              │
│ - ~/projects/**  (full codebases)                          │
├───────────────────────────────────────────────────────────┤
│ SWAP  (session persistence, cross-conversation)            │
│                                                            │
│ - Agent SDK session IDs stored in ~/system/session.json    │
│ - Resume = restore full conversation context from session  │
│ - Like hibernate: save RAM image to disk, restore on wake  │
│ - Combined with state.md, provides full continuity         │
└───────────────────────────────────────────────────────────┘
```

### Key Property: The File System Is the Source of Truth

If the conversation context gets compressed, truncated, or even starts fresh, **nothing is lost**. The state file has the OS state. The files on disk have all artifacts. The knowledge files have all capabilities. The context window is working memory -- losable and fully recoverable from disk.

---

## Demand Paging: Knowledge Files

The system prompt contains a compact table of contents of all knowledge, not the full content:

```markdown
## Available Knowledge (read the file when you need it)
- app-generation.md: How to generate HTML apps, structure, theme integration, bridge API
- healing-strategies.md: How to diagnose failures, patch patterns, rollback procedures
- theme-system.md: CSS custom properties, how apps inherit the OS theme
- data-management.md: How to structure ~/data/, JSON schemas, SQLite conventions
- module-standard.md: manifest.json schema, module types, lifecycle hooks
```

When the agent receives a build request, it reads `app-generation.md`. When it receives a heal request, it reads `healing-strategies.md`. The full knowledge is never in context unless needed. This is literal demand paging -- the page is loaded only on page fault (the agent needs it for the current task).

### Page Eviction

Knowledge files read in one turn remain in L2 cache (conversation context) for subsequent turns. When the SDK compresses older messages, these get evicted. If the agent needs them again, it re-reads them. No manual cache management needed -- the SDK's context compression IS the eviction policy.

---

## The Smart Kernel (Approach A)

The main agent is a **smart kernel** -- it has full capabilities, makes all routing decisions, and can handle simple requests directly without spawning sub-agents.

### Kernel Responsibilities

1. **Receive all user input** (from any gateway: voice, chat, terminal, API)
2. **Read current state** (state.md, modules.json, processes.json -- always in L1)
3. **Route the request:**
   - Simple query/config change -> handle directly
   - App generation -> spawn builder sub-agent
   - Diagnosis/repair -> spawn healer sub-agent
   - Complex multi-step -> orchestrate multiple sub-agents
4. **Read results from files** after sub-agents complete
5. **Update state** (state.md, modules.json, activity.log)
6. **Respond to user**

### Kernel Tools (Full Access)

The smart kernel has access to ALL Agent SDK tools:

| Tool | Kernel Use |
|------|-----------|
| **Read** | Page in knowledge files, read module manifests, check state |
| **Write** | Create config files, update state.md, write simple apps directly |
| **Edit** | Quick modifications to theme, layout, existing apps |
| **Bash** | Run commands, start/stop processes, install packages, git |
| **Glob** | Find files by pattern, discover modules |
| **Grep** | Search across modules, find specific code patterns |
| **WebSearch** | Research when building something unfamiliar |
| **WebFetch** | Fetch documentation, APIs, examples |
| **Task** | Spawn sub-agents (builder, healer, researcher, deployer) |

### When the Kernel Handles Directly (No Sub-Agent)

- "Make the background dark" -> Edit ~/system/theme.json
- "What modules do I have?" -> Read ~/system/modules.json, respond
- "Show me the expense tracker logs" -> Read log file, respond
- "Restart the notes app" -> Bash: kill + restart process
- "What's the weather?" -> WebSearch, respond

These are **system calls** -- fast, direct, no fork needed.

### When the Kernel Spawns a Sub-Agent

- "Build me a CRM" -> Spawn builder (heavy code generation)
- "The dashboard is broken" -> Spawn healer (diagnosis + patch)
- "Research the best chart library for my dashboard" -> Spawn researcher
- "Deploy my app to Vercel" -> Spawn deployer

These are **process creation** -- the kernel forks a sub-agent with its own context.

---

## Sub-Agents as Processes

Each sub-agent is a process with its own address space (context window). It doesn't inherit the kernel's conversation -- it gets a focused prompt with exactly what it needs.

### Two Tiers: Core Agents + Unlimited Custom Agents

**Core agents** are built into the OS and handle fundamental operations:

```
BUILDER
  Purpose: Generate new apps and modules from natural language
  Gets:    User request + module index + generation knowledge + theme
  Tools:   Read, Write, Edit, Bash, Glob
  Writes:  ~/modules/<name>/* or ~/apps/<name>.html
  Dies:    After generation completes

HEALER
  Purpose: Diagnose and repair broken apps/modules
  Gets:    Error logs + broken module source + manifest + healing knowledge
  Tools:   Read, Edit, Bash, Grep
  Writes:  Patched source files
  Dies:    After repair completes

RESEARCHER
  Purpose: Gather information before a build or decision
  Gets:    Research question + constraints
  Tools:   Read, Glob, Grep, WebSearch, WebFetch
  Writes:  Nothing (returns findings to kernel via Task result)
  Dies:    After research completes

DEPLOYER
  Purpose: Deploy apps/projects to hosting services
  Gets:    Project path + target platform + deployment knowledge
  Tools:   Read, Bash, Glob
  Writes:  Deployment configs, CI files
  Dies:    After deployment completes

EVOLVER
  Purpose: Modify Matrix OS itself (self-evolution)
  Gets:    Modification request + current OS source + safety constraints
  Tools:   Read, Write, Edit, Bash
  Writes:  OS source files (with git snapshot first)
  Dies:    After modification completes
```

**Custom agents** are unlimited, user-defined or kernel-created, stored as markdown files in `~/agents/custom/`. Each file defines one spawnable agent:

```markdown
# ~/agents/custom/data-analyst.md

---
name: data-analyst
description: Analyzes datasets, generates visualizations and statistical summaries
tools: [Read, Write, Edit, Bash, Glob, Grep]
knowledge: [data-management.md]
---

You are a data analysis specialist for Matrix OS.

When given a dataset or data question:
1. Read the relevant data files from ~/data/
2. Analyze using Python, R, or inline JS as appropriate
3. Generate visualizations as HTML files in ~/apps/
4. Write summary reports to ~/data/reports/
```

### Dynamic Agent Discovery

At kernel spawn time, the system scans `~/agents/custom/*.md`, parses each file's frontmatter (name, description, tools), and merges them with core agents. The full agent pool is passed to the Agent SDK.

The L1 cache includes a compact agent TOC:

```
## Available Agents
Core: builder, healer, researcher, deployer, evolver
Custom: data-analyst, copywriter, seo-optimizer, api-tester, db-admin
```

The kernel sees this TOC and can spawn any agent. The custom agent's full prompt is loaded from its file at spawn time (demand-paged, like knowledge).

### Self-Expanding Agent Pool

The kernel can create new custom agents on the fly by writing a markdown file:

```
User: "I need help optimizing my database queries"

Kernel: No db-optimizer agent exists.
  1. Write ~/agents/custom/db-optimizer.md with specialized prompt
  2. Agent is immediately available (next kernel instance will discover it)
  3. Spawn the new agent for the current task
```

This is the OS equivalent of `apt install` -- the kernel writes an executable (agent definition) to disk. The agent pool is self-expanding. The OS literally grows new capabilities by creating files.

Users can also create custom agents directly:
- Write a markdown file to ~/agents/custom/
- Or ask the kernel: "Create me an agent that specializes in X"
- Or share agent files with others (copy a .md file)

### Process Lifecycle

```
SPAWNED -> RUNNING -> COMPLETED
              |
              v
           FAILED (kernel reads error, may retry or report)
```

Sub-agents communicate results through the file system:
- Builder writes files to ~/modules/ -> kernel reads manifest.json
- Healer writes patched files -> kernel reads health status
- Custom agents write wherever their prompt specifies
- No message passing needed -- the file system IS the IPC mechanism

### Context Isolation

Sub-agents (core or custom) do NOT get:
- The user's conversation history
- Other sub-agents' work
- The kernel's full system prompt

Sub-agents DO get:
- A focused task description
- The specific files/knowledge they need (passed in the prompt or read from their definition)
- Their own fresh context window (full "RAM" for the task)

This is why sub-agents are powerful: they don't waste context on irrelevant conversation. A builder generating a 500-line app uses its entire context for code generation, not for remembering the user asked about the weather 10 minutes ago.

---

## Multiprocessing: Concurrent Kernels

Matrix OS supports true multiprocessing. Multiple kernel instances can run simultaneously, each handling a different user request.

### How It Works

Each kernel instance is a separate Agent SDK `query()` call running concurrently:

```
User: "Build me an expense tracker"     -> Kernel Instance 1 (spawned)
User: "Also make the theme darker"      -> Kernel Instance 2 (spawned)
User: "What time is it in Tokyo?"       -> Kernel Instance 3 (spawned)

All three run in parallel. None blocks the others.
```

### The Process Table: ~/system/processes.json

Every kernel instance registers itself before starting work and deregisters when done:

```json
{
  "processes": [
    {
      "id": "k-1739290800-abc",
      "type": "kernel",
      "task": "Building expense tracker web app",
      "status": "running",
      "started": "2026-02-11T14:00:00Z",
      "touching": ["~/modules/expense-tracker/"]
    },
    {
      "id": "k-1739290810-def",
      "type": "kernel",
      "task": "Updating theme to dark mode",
      "status": "running",
      "started": "2026-02-11T14:00:10Z",
      "touching": ["~/system/theme.json"]
    }
  ]
}
```

### Coordination Through Awareness

Each kernel instance reads `processes.json` as part of its L1 cache. It **knows what other kernels are doing**. This enables:

1. **Conflict avoidance**: Kernel 2 sees Kernel 1 is writing to ~/modules/expense-tracker/. It won't touch those files.

2. **Dependency awareness**: If Kernel 2's task depends on Kernel 1's output ("add dark mode to the expense tracker that's being built"), it can wait or inform the user.

3. **Progress reporting**: The user can ask "what's happening?" and any kernel can read processes.json and report on all active work.

4. **Resource awareness**: The system prompt can include rules like "if 3+ kernels are running, prefer handling simple requests directly instead of spawning sub-agents" to manage API concurrency.

### Concurrency Model

```
                     ┌─────────────────────────┐
                     │   Gateway / Dispatcher    │
                     │                           │
                     │  Receives user messages   │
                     │  Spawns kernel instances  │
                     │  Non-blocking             │
                     └─────┬───────┬───────┬─────┘
                           │       │       │
                    ┌──────┘       │       └──────┐
                    ▼              ▼              ▼
             ┌────────────┐ ┌────────────┐ ┌────────────┐
             │  Kernel 1  │ │  Kernel 2  │ │  Kernel 3  │
             │            │ │            │ │            │
             │ Own context│ │ Own context│ │ Own context│
             │ Own tools  │ │ Own tools  │ │ Own tools  │
             │ May spawn  │ │ May spawn  │ │ May spawn  │
             │ sub-agents │ │ sub-agents │ │ sub-agents │
             └─────┬──────┘ └─────┬──────┘ └─────┬──────┘
                   │              │              │
                   └──────────────┼──────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │     Shared File System      │
                    │                             │
                    │  ~/system/state.md          │
                    │  ~/system/processes.json    │
                    │  ~/system/modules.json      │
                    │  ~/modules/*                │
                    │  ~/apps/*                   │
                    │  ~/data/*                   │
                    └─────────────────────────────┘
```

### Write Coordination

Multiple kernels writing to the file system simultaneously needs basic coordination:

1. **File-level claiming**: Each kernel declares what files/directories it's "touching" in processes.json. Other kernels avoid those paths.

2. **Atomic state updates**: State.md and modules.json are updated atomically (write to temp file, rename). Last writer wins for independent fields.

3. **Convention over locking**: Kernels work in different directories by default (each module gets its own directory). Conflicts are rare by design.

4. **Optimistic concurrency**: For the rare collision (two kernels editing the same config file), the second kernel re-reads and retries. Like optimistic locking in databases.

---

## The State File: ~/system/state.md

The most important file in Matrix OS. It's the kernel's compact view of everything that exists. Always in L1 cache (injected into every kernel's system prompt).

```markdown
# Matrix OS State

## System
- Boot time: 2026-02-11T10:00:00Z
- Theme: dark, orange accents
- Layout: dock-left, 3-column grid

## Modules
| Name | Type | Port | Status | Description |
|------|------|------|--------|-------------|
| expense-web | web | 3001 | healthy | Expense tracking dashboard |
| expense-cli | cli | - | ready | CLI for logging expenses |
| notes-app | web | 3002 | healthy | Markdown notes with search |

## Recent Activity
- [14:00] Built expense-web from "track my daily expenses"
- [14:02] Built expense-cli, wired to expense-web data
- [14:10] Built notes-app from "I need a place for notes"
- [14:15] Healed expense-web (fixed malformed SQL query)
- [14:20] Updated theme to dark mode with orange accents

## Active Processes
- Kernel k-abc: Building CRM module (started 30s ago)

## User Context
- Prefers dark themes
- Works with expense data frequently
- Has asked about calendar integration (not yet connected)
```

This is ~400-500 tokens. Cheap enough to always include. Rich enough for the kernel to make informed decisions.

---

## System Prompt Assembly

The system prompt is the "BIOS + bootloader" -- it's assembled from files every time the kernel starts:

```
~/agents/
  system-prompt.md          Core identity, behavior rules, routing logic
  knowledge/
    app-generation.md       How to generate apps (demand-paged)
    healing-strategies.md   How to diagnose and fix (demand-paged)
    theme-system.md         Theme system docs (demand-paged)
    data-management.md      Data conventions (demand-paged)
    module-standard.md      Module manifest + lifecycle (demand-paged)
    shell-api.md            How apps talk to the OS shell (demand-paged)
  memory/
    long-term.md            Persistent observations about the user
    2026-02-11.md           Today's notes
  user-profile.md           User preferences and context
  heartbeat.md              Proactive tasks to check periodically
```

### Assembly Order (what goes into the system prompt)

```
1. REGISTERS (always loaded, ~2K tokens):
   <- ~/agents/system-prompt.md

2. L1 CACHE (always loaded, ~3-4K tokens):
   <- ~/system/state.md
   <- ~/system/processes.json (active kernels)
   <- last 10 lines of ~/system/activity.log
   <- knowledge TOC (names + one-line descriptions)

3. USER CONTEXT (always loaded, ~500 tokens):
   <- ~/agents/user-profile.md
   <- ~/agents/memory/long-term.md (if small)

Total system prompt: ~6-7K tokens
Leaves the vast majority of context for conversation + tool results
```

---

## Session Lifecycle: Boot, Run, Hibernate, Wake

### Cold Boot (first launch or fresh start)

```
1. Build system prompt from files
2. No session ID to resume
3. Kernel starts with state.md awareness but no conversation history
4. User starts talking, context builds naturally
```

### Warm Run (ongoing conversation)

```
1. User sends message
2. Gateway dispatches to kernel instance
3. Kernel's system prompt is rebuilt (fresh L1 cache)
4. Conversation context carries forward in L2 cache
5. Kernel processes, responds, updates state
```

### Hibernate (user closes Matrix OS)

```
1. Save current Agent SDK session ID to ~/system/session.json
2. state.md is already current
3. All module files are on disk
4. Nothing is lost
```

### Wake (user reopens Matrix OS)

```
Option A: Resume (warm wake)
  1. Read session ID from ~/system/session.json
  2. Pass to Agent SDK with resume flag
  3. Full conversation context restored
  4. System prompt rebuilt with fresh state.md
  -> Continuity: "Welcome back. You were working on the CRM."

Option B: Fresh start (cold wake)
  1. New Agent SDK session
  2. System prompt rebuilt from files
  3. state.md tells the kernel everything that exists
  4. No conversation history, but full state awareness
  -> Continuity: "I see you have 3 modules running. What would you like to do?"
```

Both work because the file system is the source of truth, not the conversation.

---

## Context Budget Planning

For a ~200K token context window:

| Layer | Tokens | % of Context |
|-------|--------|-------------|
| System prompt (registers) | ~2,000 | 1% |
| L1 cache (state, modules, processes) | ~3,500 | 1.75% |
| User profile + memory | ~500 | 0.25% |
| **Remaining for conversation + tools** | **~194,000** | **97%** |

This leaves 97% of context for actual work. The OS overhead is minimal. A builder sub-agent generating a complex app has nearly the full context window available for code generation.

### When Context Gets Full

The Agent SDK automatically compresses older messages. But state.md ensures continuity:

```
Turn 1-50: Full conversation (rich context)
Turn 51+: SDK compresses turns 1-30 into summaries
          Turns 31-51 remain full
          state.md re-read every turn (always fresh)

Result: The kernel always knows current state (from files),
        recent conversation (from L2), and can re-read anything
        it needs from disk (via tools).
```

---

## Heartbeat: Proactive Background Processing

Separate from user-triggered kernels, a heartbeat process runs periodically:

```
Every N minutes:
  1. Spawn a lightweight kernel instance
  2. System prompt includes ~/agents/heartbeat.md
  3. Kernel checks:
     - Module health (are all processes alive?)
     - Pending tasks from heartbeat.md
     - Disk usage, stale data, optimization opportunities
  4. If action needed: perform it, update state.md, log activity
  5. If not: exit quietly
```

The heartbeat kernel is another concurrent process. It reads the same state.md, registers in processes.json, and coordinates with any user-triggered kernels that may be running.

```markdown
# ~/agents/heartbeat.md

## Health Checks
- Ping all running web modules every 5 minutes
- If a module fails health check 3 times, spawn healer

## Scheduled Tasks
- Every Monday 9am: generate weekly summary of activity
- Daily midnight: archive old session logs

## Observations
- User creates expense entries every Friday afternoon
  -> Offer to automate this next Friday
```

---

## Full Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                        USER LAYER                             │
│    Voice  |  Web Chat  |  Terminal  |  REST API  |  MCP      │
└──────┬───────────┬───────────┬──────────┬───────────┬────────┘
       │           │           │          │           │
       ▼           ▼           ▼          ▼           ▼
┌──────────────────────────────────────────────────────────────┐
│                    GATEWAY / DISPATCHER                        │
│                                                                │
│  - Receives messages from all input channels                  │
│  - Spawns kernel instances (non-blocking)                     │
│  - Multiple requests -> multiple concurrent kernels           │
│  - Routes kernel responses back to originating channel        │
└──────────────────────────┬───────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│   KERNEL 1    │ │   KERNEL 2    │ │  HEARTBEAT    │
│               │ │               │ │   KERNEL      │
│ Smart agent   │ │ Smart agent   │ │               │
│ Full tools    │ │ Full tools    │ │ Health checks │
│ Own context   │ │ Own context   │ │ Scheduled     │
│               │ │               │ │ tasks         │
│ ┌───────────┐ │ │               │ │               │
│ │ Builder   │ │ │  (handling a  │ │               │
│ │ sub-agent │ │ │  quick theme  │ │               │
│ │ (spawned) │ │ │  change       │ │               │
│ └───────────┘ │ │  directly)    │ │               │
└───────┬───────┘ └───────┬───────┘ └───────┬───────┘
        │                 │                 │
        └─────────────────┼─────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│                    SHARED FILE SYSTEM                          │
│                                                                │
│  ~/system/                                                    │
│    state.md            Live OS state (L1 cache for all)       │
│    processes.json      Active kernels and their tasks         │
│    modules.json        Module registry                        │
│    activity.log        Chronological action log               │
│    theme.json          Visual theme                           │
│    layout.json         Window/dock layout                     │
│    config.json         Core OS configuration                  │
│    session.json        Saved session IDs for resume           │
│                                                                │
│  ~/agents/                                                    │
│    system-prompt.md    Kernel identity and rules              │
│    knowledge/*.md      Demand-paged knowledge files           │
│    memory/*.md         Long-term memory + daily notes         │
│    user-profile.md     User preferences                       │
│    heartbeat.md        Proactive task list                    │
│                                                                │
│  ~/apps/               HTML apps (rendered by shell)          │
│  ~/modules/            Generated modules with manifests       │
│  ~/projects/           Full codebases (React, Next.js, etc.)  │
│  ~/data/               User data (JSON, SQLite, etc.)         │
│  ~/tools/              Scripts and automation                 │
│  ~/sessions/           Conversation archives (JSONL)          │
│  ~/templates/          Reusable app/module templates          │
│  ~/themes/             Theme presets                          │
│                                                                │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│                    WEB SHELL (RENDERER)                        │
│                                                                │
│  Watches the file system. Renders what it finds.              │
│  Does NOT know what apps exist ahead of time.                 │
│  New file in ~/apps/ -> new window appears.                   │
│  File changes -> display updates.                             │
│  Theme changes -> everything re-skins.                        │
│                                                                │
│  Components:                                                  │
│  - Desktop canvas (window management)                         │
│  - App viewer (iframes for HTML apps)                         │
│  - Chat panel (talk to the kernel)                            │
│  - Activity feed (streams from activity.log)                  │
│  - Module graph (vis-network, from modules.json)              │
│  - Dock / launcher (from layout.json)                         │
│                                                                │
│  The shell is optional. Matrix OS works headlessly.           │
│  The shell is one possible renderer. Others: CLI, mobile,     │
│  voice-only, watch, car dashboard. All read the same files.   │
└──────────────────────────────────────────────────────────────┘
```

---

## Implementation: The Kernel in Code

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// Core agents: ship with the OS
const coreAgents = {
  "builder": {
    description: "Generates apps and modules from natural language",
    prompt: builderPrompt,
    tools: ["Read", "Write", "Edit", "Bash", "Glob"]
  },
  "healer": {
    description: "Diagnoses and repairs broken apps and modules",
    prompt: healerPrompt,
    tools: ["Read", "Edit", "Bash", "Grep"]
  },
  "researcher": {
    description: "Researches libraries, APIs, patterns before building",
    prompt: researcherPrompt,
    tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]
  },
  "deployer": {
    description: "Deploys projects to hosting platforms",
    prompt: deployerPrompt,
    tools: ["Read", "Bash", "Glob"]
  },
  "evolver": {
    description: "Modifies Matrix OS itself (with git safety)",
    prompt: evolverPrompt,
    tools: ["Read", "Write", "Edit", "Bash"]
  }
};

// Custom agents: loaded dynamically from ~/agents/custom/*.md
async function loadCustomAgents(): Promise<Record<string, AgentDef>> {
  const files = await glob('~/agents/custom/*.md');
  const agents: Record<string, AgentDef> = {};
  for (const file of files) {
    const { frontmatter, body } = parseMarkdownWithFrontmatter(await readFile(file));
    agents[frontmatter.name] = {
      description: frontmatter.description,
      prompt: body,
      tools: frontmatter.tools ?? ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
    };
  }
  return agents;
}

// Spawn a kernel instance for a user message
async function spawnKernel(userMessage: string, sessionId?: string) {
  const processId = registerProcess(userMessage);
  const systemPrompt = await buildSystemPrompt();

  // Merge core + custom agents. Custom can override core. Pool is unlimited.
  const customAgents = await loadCustomAgents();
  const allAgents = { ...coreAgents, ...customAgents };

  try {
    const result = await query({
      prompt: userMessage,
      options: {
        systemPrompt,
        resume: sessionId,
        allowedTools: [
          "Read", "Write", "Edit", "Bash",
          "Glob", "Grep", "WebSearch", "WebFetch",
          "Task"  // for spawning any agent in allAgents
        ],
        permissionMode: "bypassPermissions",
        agents: allAgents,  // core + all custom agents, dynamically loaded
        hooks: {
          PostToolUse: [
            {
              matcher: "Write|Edit",
              hooks: [updateStateHook, notifyShellHook, gitSnapshotHook]
            },
            {
              matcher: "Bash",
              hooks: [safetyGuardHook, logActivityHook]
            }
          ],
          Stop: [persistSessionHook]
        }
      }
    });

    return result;
  } finally {
    deregisterProcess(processId);
  }
}

// Multiprocessing: handle concurrent requests
async function handleUserMessage(message: string) {
  // Non-blocking: spawn kernel, don't await if user sends another message
  return spawnKernel(message);
}
```

### System Prompt Builder

```typescript
async function buildSystemPrompt(): Promise<string> {
  // REGISTERS (static, ~2K tokens)
  const core = await readFile('~/agents/system-prompt.md');

  // L1 CACHE (dynamic, ~3-4K tokens)
  const state = await readFile('~/system/state.md');
  const processes = await readFile('~/system/processes.json');
  const activity = await lastLines('~/system/activity.log', 10);
  const knowledgeTOC = await buildKnowledgeTOC('~/agents/knowledge/');

  // USER CONTEXT (~500 tokens)
  const userProfile = await readFile('~/agents/user-profile.md');
  const memory = await readFile('~/agents/memory/long-term.md');

  return `
${core}

## Current OS State
${state}

## Active Processes
${JSON.stringify(processes, null, 2)}

## Recent Activity
${activity}

## Available Knowledge
${knowledgeTOC}
Read any knowledge file when you need it for the current task.

## User Profile
${userProfile}

## Memory
${memory}
`.trim();
}
```

---

## Summary

| Concept | Implementation |
|---------|---------------|
| **RAM** | Agent SDK context window, managed through memory hierarchy |
| **CPU** | Claude Opus 4.6 reasoning engine |
| **Multi-core** | Concurrent kernel instances via parallel query() calls |
| **Kernel** | Smart main agent with full tools, routes or handles directly |
| **Processes** | Sub-agents: 5 core (builder, healer, researcher, deployer, evolver) + unlimited custom agents from ~/agents/custom/*.md |
| **Process table** | ~/system/processes.json |
| **Virtual memory** | Demand-paged knowledge files (TOC in prompt, full on Read) |
| **Disk** | File system -- everything is a file, source of truth |
| **Swap** | Agent SDK session resume (hibernate/wake) |
| **IPC** | File system (agents coordinate through shared files) |
| **Boot** | System prompt assembly from ~/agents/ files |
| **BIOS** | Static system-prompt.md (core identity, never changes) |
| **Drivers** | MCP servers (external service connections) |
| **Heartbeat** | Periodic background kernel for proactive tasks |
