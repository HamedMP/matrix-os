# Matrix OS -- Final Specification

## The Operating System That Builds Itself

---

## 1. What Matrix OS Is

Matrix OS is a real-time, self-expanding operating system where software doesn't exist until you need it.

You open it and see a clean desktop. You describe what you need -- by voice, text, or terminal -- and the system writes working software into existence, saves it as real files you own, and renders it on screen. You never installed anything. You never downloaded anything. The software was born in the moment, tailored to you, and it's yours.

When something breaks, the OS detects it, diagnoses the root cause, and patches itself. When you need more, it builds more -- including improvements to itself. The entire operating system is alive: growing, healing, and adapting to its user.

Everything the OS creates, stores, and configures is a file on disk. You can see inside any app, copy it to another machine, back up the whole OS by copying a folder, or email an app to a friend. There is no hidden state, no opaque database, no black box. Just files.

### Where It Runs

Matrix OS is installed on a machine. That machine can be your laptop, a home server, or a cloud VM. The data lives locally on that machine. "Local-first" means the OS owns its files and doesn't depend on external services for its core function. Whether "local" is your desk or a data center is your choice.

### The Synthesis

Matrix OS combines two ideas that haven't been fused before:

1. **Real-time software generation** (like Anthropic's "Imagine with Claude") -- where entire applications are born from conversation. The problem: everything is ephemeral, nothing persists.

2. **Personal AI agent on your machine** (like OpenClaw) -- with persistent memory, full system access, and the ability to extend itself. The problem: it orchestrates existing software but doesn't create new software.

Matrix OS is both at once. It generates software in real time AND persists everything as files. The agent doesn't just use tools -- it creates them. And because everything is files, the OS accumulates the tools and workflows you've asked for over time.

---

## 2. The Computer Architecture Metaphor

This isn't a decorative analogy. Matrix OS maps precisely to real computer architecture, and this mapping drives every design decision.

| Computer Architecture | Matrix OS Equivalent |
|----------------------|---------------------|
| CPU | Claude Opus 4.6 (reasoning engine) |
| CPU Cores | Concurrent kernel instances (parallel agent sessions) |
| RAM | Agent SDK context window (working memory, finite) |
| Kernel | Smart main agent with full tool access |
| Processes | Sub-agents (builder, healer, researcher, deployer, evolver) |
| Process Table | ~/system/processes.json |
| Virtual Memory | Demand-paged knowledge files (TOC in prompt, loaded on access) |
| Disk / SSD | File system -- everything is a file, source of truth |
| Swap | Agent SDK session resume (hibernate to disk, restore on wake) |
| System Calls | Agent SDK tools (Read, Write, Edit, Bash, Glob, Grep, etc.) |
| IPC | Shared file system (agents coordinate through files) |
| BIOS / Firmware | Static system prompt (core identity, never evicted) |
| Device Drivers | MCP servers (external service connections) |
| Desktop Environment | Web shell (browser-based renderer, watches file system) |
| Bootloader | System prompt assembly (reads state files, builds context) |

---

## 3. The Kernel: Claude Agent SDK

The Claude Agent SDK is the operating system's kernel. It has full control over the machine: file system, shell, processes, network, package managers, compilers, deployment tools. It can do anything a developer with terminal access can do -- but it understands natural language instead of system calls.

### Smart Kernel (Approach A)

The main agent is powerful. It has all tools, reads knowledge files, makes all routing decisions, and can handle simple requests directly. It only spawns sub-agents for heavy work.

**Kernel responsibilities:**

1. Receive all user input (from any gateway: voice, chat, terminal, API)
2. Read current state (state.md, modules.json, processes.json -- always in L1 cache)
3. Route the request:
   - Simple query or config change -> handle directly (system call)
   - App generation -> spawn builder sub-agent (fork process)
   - Diagnosis/repair -> spawn healer sub-agent (fork process)
   - Complex multi-step -> orchestrate multiple sub-agents
4. Read results from files after sub-agents complete
5. Update OS state (state.md, modules.json, activity.log)
6. Respond to user

**Kernel tools (full access):**

| Tool | Use |
|------|-----|
| Read | Page in knowledge files, read manifests, check state |
| Write | Create config files, update state, write simple apps directly |
| Edit | Quick modifications to theme, layout, existing apps |
| Bash | Run commands, start/stop processes, install packages, git |
| Glob | Find files by pattern, discover modules |
| Grep | Search across modules, find code patterns |
| WebSearch | Research when building something unfamiliar |
| WebFetch | Fetch documentation, APIs, examples |
| Task | Spawn sub-agents (builder, healer, researcher, deployer, evolver) |

**Direct handling (no sub-agent, fast):**
- "Make the background dark" -> Edit ~/system/theme.json
- "What modules do I have?" -> Read modules.json, respond
- "Restart the notes app" -> Bash: kill + restart
- "What's the weather?" -> WebSearch, respond

**Fork to sub-agent (own context, heavy work):**
- "Build me a CRM" -> Spawn builder
- "The dashboard is broken" -> Spawn healer
- "Deploy my app to Vercel" -> Spawn deployer

### Multiprocessing: Concurrent Kernels

Matrix OS supports true multiprocessing. Multiple kernel instances run simultaneously, each handling a different user request. None blocks the others.

```
User: "Build me an expense tracker"     -> Kernel Instance 1
User: "Also make the theme darker"      -> Kernel Instance 2
User: "What time is it in Tokyo?"       -> Kernel Instance 3

All three run in parallel. Each has its own context window (own RAM).
```

**How it works:**

Each kernel instance is a separate Agent SDK `query()` call. The gateway/dispatcher spawns them without waiting for previous ones to finish.

**Coordination through awareness:**

Every kernel instance reads `~/system/processes.json` as part of its L1 cache. It knows what other kernels are doing.

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

This enables:
- **Conflict avoidance**: Kernel 2 sees Kernel 1 is writing to ~/modules/expense-tracker/. It won't touch those files.
- **Dependency awareness**: If a task depends on another kernel's output, it can wait or inform the user.
- **Progress reporting**: "What's happening?" -> any kernel reads processes.json and reports all active work.
- **Resource awareness**: System prompt rules like "if 3+ kernels running, prefer direct handling over sub-agent spawning."

**Write coordination:**
- File-level claiming via the `touching` field in processes.json
- Kernels work in different directories by default (conflicts rare by design)
- Atomic state updates (write to temp file, rename)
- Optimistic concurrency for rare collisions (re-read, retry)

---

## 4. Memory Architecture

The agent's context window is finite, just like RAM. Matrix OS manages this through a strict memory hierarchy.

### The Hierarchy

```
REGISTERS  (~2K tokens, always in system prompt, never evicted)
  OS identity and personality
  File system conventions (where things go)
  Routing rules (when to dispatch vs handle directly)
  Sub-agent definitions
  Safety constraints

L1 CACHE  (~3-4K tokens, injected into system prompt, rebuilt every interaction)
  ~/system/state.md        Live OS state summary
  ~/system/modules.json    Module index (names, types, ports, status)
  ~/system/processes.json  Active kernel instances and their tasks
  Last 10 lines of ~/system/activity.log
  Knowledge table of contents (names + one-line summaries, not full content)

L2 CACHE  (conversation context, grows during session)
  Current conversation turns
  Sub-agent result summaries
  Recently read file contents
  Auto-compressed by SDK when approaching context limit

MAIN MEMORY  (files on disk, readable via tools, fast)
  ~/agents/knowledge/*.md    Full knowledge files (loaded on demand)
  ~/modules/*/manifest.json  Module details
  ~/system/*.json            Theme, layout, config, providers
  ~/agents/memory/*.md       Long-term observations

DISK  (files on disk, larger payloads)
  ~/modules/*/src/**         Full source code
  ~/apps/*.html              Generated HTML applications
  ~/data/**                  User data (JSON, SQLite, etc.)
  ~/projects/**              Full codebases
  ~/sessions/*.jsonl         Conversation archives

SWAP  (session persistence, cross-conversation)
  Agent SDK session IDs in ~/system/session.json
  Resume = restore full context from session
  Like hibernate: save RAM image to disk, restore on wake
```

### Key Property: The File System Is the Source of Truth

If the conversation context gets compressed, truncated, or starts fresh -- nothing is lost. State.md has the OS state. Files on disk have all artifacts. Knowledge files have all capabilities. The context window is working memory: losable and fully recoverable from disk.

### Demand Paging

The system prompt includes a table of contents of knowledge, not the full content:

```
## Available Knowledge (read the file when you need it)
- app-generation.md: How to generate HTML apps, conventions, theme integration
- healing-strategies.md: How to diagnose failures, patch patterns, rollback
- theme-system.md: CSS custom properties, how apps inherit the OS theme
- data-management.md: How to structure data files, schemas
- module-standard.md: manifest.json schema, module types, lifecycle
```

When the agent receives a build request, it reads `app-generation.md`. When a heal request, `healing-strategies.md`. The full knowledge is only in context when needed. This is literal demand paging -- the page loads only on page fault.

**Eviction:** When the SDK compresses older messages, previously-read knowledge files get evicted from L2. If needed again, the agent re-reads them. The SDK's context compression IS the eviction policy.

### Context Budget

For a ~200K token context window:

| Layer | Tokens | % of Context |
|-------|--------|-------------|
| System prompt (registers) | ~2,000 | 1% |
| L1 cache (state, modules, processes) | ~3,500 | 1.75% |
| User profile + memory | ~500 | 0.25% |
| **Remaining for work** | **~194,000** | **97%** |

The OS overhead is 3% of context. A builder sub-agent generating a complex app has nearly the full window available.

### The State File: ~/system/state.md

The most important file in the system. The kernel's compact view of everything. Always in L1 cache (~400-500 tokens).

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
- [14:15] Healed expense-web (fixed malformed SQL query)
- [14:20] Updated theme to dark mode with orange accents

## Active Processes
- Kernel k-abc: Building CRM module (started 30s ago)

## User Context
- Prefers dark themes
- Works with expense data frequently
```

### System Prompt Assembly

The system prompt is assembled from files before every kernel interaction:

```
1. REGISTERS (static, ~2K tokens)
   <- ~/agents/system-prompt.md

2. L1 CACHE (dynamic, ~3-4K tokens)
   <- ~/system/state.md
   <- ~/system/processes.json
   <- last 10 lines of ~/system/activity.log
   <- knowledge table of contents

3. USER CONTEXT (~500 tokens)
   <- ~/agents/user-profile.md
   <- ~/agents/memory/long-term.md

Total: ~6-7K tokens. Rebuilt every interaction. Always reflects reality.
```

### Session Lifecycle

**Cold boot:** Build system prompt from files. No session to resume. State.md provides awareness.

**Warm run:** Conversation context carries forward. System prompt rebuilt with fresh L1 cache.

**Hibernate:** Save Agent SDK session ID to ~/system/session.json. State.md is already current. Nothing is lost.

**Wake (warm):** Resume session ID. Full conversation context restored. System prompt rebuilt fresh.

**Wake (cold):** New session. State.md tells the kernel everything that exists. No conversation history, but full state awareness.

---

## 5. Sub-Agents as Processes

Each sub-agent has its own context window (own RAM). It doesn't inherit the kernel's conversation -- it gets a focused prompt with exactly what it needs.

### Two Tiers of Sub-Agents

**Core agents** ship with the OS. They handle fundamental operations:

| Agent | Purpose | Receives | Tools | Writes To |
|-------|---------|----------|-------|-----------|
| **Builder** | Generate apps/modules from natural language | Request + module index + generation knowledge + theme | Read, Write, Edit, Bash, Glob | ~/modules/ or ~/apps/ |
| **Healer** | Diagnose and repair broken apps | Error logs + source + manifest + healing knowledge | Read, Edit, Bash, Grep | Patched source files |
| **Researcher** | Gather info before a decision | Research question + constraints | Read, Glob, Grep, WebSearch, WebFetch | Nothing (returns via Task result) |
| **Deployer** | Deploy to hosting services | Project path + target + deployment knowledge | Read, Bash, Glob | Deployment configs |
| **Evolver** | Modify Matrix OS itself | Modification request + OS source + safety rules | Read, Write, Edit, Bash | OS source (with git snapshot) |

**Custom agents** are user-defined or kernel-created. There is no limit on how many can exist. A custom agent is a markdown file in `~/agents/custom/`:

```markdown
# ~/agents/custom/data-analyst.md

---
name: data-analyst
description: Analyzes datasets, generates visualizations and statistical summaries
tools: [Read, Write, Edit, Bash, Glob, Grep]
---

You are a data analysis specialist for Matrix OS.

When given a dataset or data question:
1. Read the relevant data files from ~/data/
2. Analyze using Python, R, or inline JS as appropriate
3. Generate visualizations as HTML files in ~/apps/
4. Write summary reports to ~/data/reports/

You have access to the user's full data directory. Use pandas, matplotlib,
or any tools installable via pip/npm. Always save results as files.
```

### Dynamic Agent Registry

The kernel discovers available agents at boot by scanning:
1. Built-in core agents (hardcoded in the kernel)
2. `~/agents/custom/*.md` (user-defined or kernel-created custom agents)

The L1 cache includes a compact agent TOC alongside the knowledge TOC:

```
## Available Agents
Core: builder, healer, researcher, deployer, evolver
Custom: data-analyst, copywriter, seo-optimizer, api-tester, db-admin
```

The kernel can spawn ANY of these via the Task tool. The custom agent's full prompt is read from its markdown file at spawn time (demand-paged, like knowledge files).

### The Kernel Creates New Agents

The kernel itself can create new custom agents on the fly. If a user asks for something that doesn't map to existing agents, the kernel writes a new agent definition file:

```
User: "I need help optimizing my database queries"

Kernel thinks: No db-specialist agent exists. I'll create one.
  1. Write ~/agents/custom/db-optimizer.md with specialized prompt
  2. Agent is immediately available for this and future requests
  3. Spawn the new agent for the current task
```

This is the OS equivalent of installing a new program. The kernel writes an executable (agent definition) to disk, and it's ready to run. The OS literally grows new capabilities by creating agents.

### Agent Definition Schema

Every custom agent file follows a standard format:

```markdown
---
name: <unique-name>
description: <one-line description for the agent TOC>
tools: [<list of Agent SDK tools this agent gets>]
model: <opus | sonnet | haiku | inherit>
inject: [<optional list of knowledge files to prepend to prompt>]
mcp: [<optional list of MCP servers to connect>]
---

<Full system prompt for the agent>

This prompt can be as detailed as needed. It defines:
- What the agent specializes in
- How it should approach tasks
- Where to read from and write to
- What conventions to follow
```

Note: The SDK `AgentDefinition` interface supports four fields: `description`, `prompt`, `tools`, `model`. The `inject` field is a Matrix OS convention -- the kernel reads the referenced knowledge files from `~/agents/knowledge/` and prepends their content to the agent's `prompt` string before passing it to the SDK. The `mcp` field is resolved to `mcpServers` config at spawn time.

### Agent Composition

Custom agents can reference other agents. The kernel can orchestrate multi-agent workflows:

```
User: "Build me a landing page and optimize it for SEO"

Kernel orchestrates:
  1. Spawn builder -> generates the landing page
  2. Spawn seo-optimizer (custom agent) -> analyzes and improves it
  3. Both write to the same module directory
  4. Kernel reports the combined result
```

### Context Isolation

Sub-agents (core or custom) do NOT get the user's conversation history, other sub-agents' work, or the kernel's full system prompt. They get a focused task description and the specific files/knowledge they need. This is why they're powerful: a builder generating a 500-line app uses its entire context for code generation, not for conversation history.

### Communication via Files

Sub-agents don't return large results through conversation. They write to the file system. The kernel reads the outcome. The file system IS the IPC mechanism.

---

## 6. The File System

### Directory Layout

```
~/                              The OS root (the "hard drive")
  system/                       OS configuration and state
    state.md                    Live OS state (most important file)
    processes.json              Active kernel instances
    modules.json                Module registry
    activity.log                Chronological action log
    theme.json                  Visual theme (colors, fonts, spacing)
    layout.json                 Desktop layout (dock, grid, window positions)
    config.json                 Core OS config (ports, paths, features)
    session.json                Saved session IDs for resume
    mcp/                        MCP server configurations
      github.json
      calendar.json

  agents/                       Agent brain (knowledge, memory, identity)
    system-prompt.md            Core identity and behavior rules
    knowledge/                  Demand-paged knowledge files
      app-generation.md         How to generate apps
      healing-strategies.md     How to diagnose and fix
      theme-system.md           How the theme system works
      data-management.md        Data conventions
      module-standard.md        Module manifest and lifecycle
      shell-api.md              How apps talk to the OS shell
    custom/                     Custom agent definitions (unlimited)
      data-analyst.md           User-created or kernel-created agents
      copywriter.md             Each file = one spawnable agent
      db-optimizer.md           Kernel can create new ones on the fly
    memory/                     Persistent observations
      long-term.md              Cross-session learnings
      2026-02-11.md             Today's notes
    user-profile.md             User preferences and context
    heartbeat.md                Proactive tasks to check periodically

  apps/                         Generated HTML apps (rendered by shell)
    tasks.html
    notes.html
    dashboard.html

  modules/                      Generated modules with structure
    expense-tracker/
      manifest.json             Module metadata, type, deps, interfaces
      src/                      Source code
      data/                     Module-specific data

  projects/                     Full codebases (React, Next.js, etc.)
  data/                         User data (JSON, SQLite, etc.)
  tools/                        Scripts and automation
  sessions/                     Conversation archives (JSONL)
  templates/                    Reusable app/module templates
  themes/                       Theme presets
```

### Everything Is a File

- An app is an HTML file in ~/apps/
- A theme is a JSON file in ~/system/theme.json
- The agent's personality is a markdown file in ~/agents/system-prompt.md
- The agent's memory is markdown files in ~/agents/memory/
- The OS state is a markdown file in ~/system/state.md
- A module is a directory with a manifest.json and source files
- A custom agent is a markdown file in ~/agents/custom/ (the OS creates new capabilities by writing files)
- A user's data is JSON/SQLite in ~/data/
- Sharing an app = sending a file. Sharing an agent = sending a markdown file. Backing up = copying a folder.

### Module Standard

Modules follow a lightweight standard with a manifest:

```json
{
  "name": "expense-tracker",
  "type": "web",
  "version": "1.0.0",
  "description": "Web dashboard for tracking daily expenses",
  "created": "2026-02-11T14:00:00Z",
  "port": 3001,
  "provides": ["expense-api"],
  "depends": ["expense-data"],
  "health": { "endpoint": "/health", "interval": 30 },
  "status": "running"
}
```

Module types: `web` (HTTP server), `cli` (executable), `api` (standalone service), `cron` (scheduled task), `lib` (shared utility).

Modules communicate through shared SQLite databases (simplest), HTTP between services, or shared data files.

---

## 7. The Web Shell (Desktop Metaphor)

The shell is a browser-based desktop environment that watches the file system and renders what it finds. It doesn't know ahead of time what apps exist. It discovers them.

### How It Works

```
File system changes -> fs.watch / chokidar detects -> WebSocket push -> Shell re-renders
```

- New file in ~/apps/ -> new window appears on the desktop
- File changes -> display updates (iframe reload)
- ~/system/theme.json edited -> entire OS re-skins
- ~/system/layout.json edited -> windows rearrange

### Shell Components

| Component | Source | Purpose |
|-----------|--------|---------|
| Desktop canvas | React | Window management, drag, resize |
| App viewer | iframes | Renders HTML apps from ~/apps/ |
| Chat panel | React + WebSocket | Talk to the kernel, streaming responses |
| Activity feed | WebSocket | Streams from activity.log in real-time |
| Module graph | vis-network | Visualizes modules and connections |
| Dock / launcher | React | From layout.json, click to open apps |
| Terminal | xterm.js + node-pty | Real shell in the browser |
| Code editor | Monaco | Edit any file in the OS |
| File browser | React tree view | Navigate the file system |

### Theme Propagation

All apps inherit the OS theme through CSS custom properties injected via the shell:

```css
:root {
  --os-bg: #1a1a2e;
  --os-text: #e0e0e0;
  --os-accent: #ff6b35;
  --os-font: 'Inter', sans-serif;
  /* ... read from ~/system/theme.json */
}
```

Apps rendered in iframes receive these variables. "Make everything dark with orange accents" -> the agent edits theme.json -> the shell updates CSS variables -> every app re-skins instantly.

### The Shell Is Optional

The shell is one possible renderer. The core (kernel + file system) works without it. Other possible shells: CLI-only, mobile app, voice-only device, car dashboard. All read the same files.

---

## 8. Self-Healing

When something breaks, the OS detects, diagnoses, and repairs automatically.

### The Loop

```
Health check (every 30s per module)
  |
  Module responding? --yes--> All good
  |
  no
  |
  Collect context: error logs, source code, manifest, dependency status
  |
  Spawn healer sub-agent
  |
  Healer reads context, diagnoses root cause (Opus 4.6 reasoning)
  |
  Healer generates patch, writes to files
  |
  Validate: run tests, check health
  |
  Tests pass? --no--> Rollback (restore backup), flag for user
  |
  yes
  |
  Restart module. Update state.md. Log the healing event.
```

### Safety

- Module source is backed up before patching (cp -r)
- If the patch fails tests, the backup is restored
- The healing event is logged with full context (what broke, what was tried, what worked)
- The user can always see what happened in the activity log

---

## 9. Self-Evolution

The most powerful capability: the OS can modify itself.

The evolver sub-agent can:
1. Write new knowledge files (teach the agent new patterns)
2. Edit the system prompt (change its own behavior)
3. Modify the shell (improve the UI)
4. Create new tools as scripts in ~/tools/
5. Install software via Bash
6. Create new specialized sub-agents

### Safety for Self-Evolution

1. Git snapshot before any modification to OS source files (via PostToolUse hook)
2. Protected files list (core kernel code, critical config)
3. Watchdog process that monitors the OS -- if it crashes, revert last commit, restart
4. User confirmation for modifications to protected files
5. `git tag` before demo recording for nuclear rollback

---

## 10. Proactive Behavior: Heartbeat

The OS doesn't just respond -- it anticipates.

A heartbeat kernel instance runs periodically (configurable interval). It reads ~/agents/heartbeat.md and acts on listed tasks:

```markdown
# ~/agents/heartbeat.md

## Health Checks
- Ping all running web modules every 5 minutes
- If a module fails 3 consecutive checks, spawn healer

## Scheduled Tasks
- Every Monday 9am: generate weekly activity summary
- Daily midnight: archive old session logs

## Observations
- User creates expense entries every Friday afternoon
  -> Offer to automate this next Friday
```

The heartbeat is another concurrent kernel instance. It registers in processes.json and coordinates with user-triggered kernels.

---

## 11. Gateways

All user input flows through gateways into the kernel. The kernel doesn't know or care which gateway a message came from.

| Gateway | Input | Output | Priority |
|---------|-------|--------|----------|
| Web Chat | Typed text | Streaming text + file mutations visible in shell | P0 |
| Terminal | Commands | Command output in xterm.js | P0 |
| REST API | HTTP requests | JSON responses + file mutations | P0 |
| Voice | Speech-to-text | Text-to-speech + file mutations | P1 |
| MCP | Tool calls from external agents | Tool results + file mutations | P2 |

Voice is part of the vision and the most natural interface, but for the hackathon, web chat and terminal are the priority gateways.

---

## 12. Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Language | TypeScript (strict, ESM) | Type safety, our expertise |
| Runtime | Node.js 22+ | Native TypeScript ecosystem |
| AI Kernel | Claude Agent SDK (Opus 4.6) | IS the kernel. Built-in tools, sub-agents, hooks, MCP |
| Web Server | Hono | Lightweight, WebSocket support, fast |
| Frontend | React + Vite | Fast dev, component libraries |
| Database | SQLite (better-sqlite3) | Module data, zero config |
| Terminal | xterm.js + node-pty | Industry standard (VS Code uses this) |
| Code Editor | Monaco (@monaco-editor/react) | VS Code quality, 3 lines of JSX |
| Graph Viz | vis-network | Module graph visualization |
| Reverse Proxy | httpxy (UnJS) | Route web modules through single URL |
| Validation | Zod | Schema validation + TypeScript types |
| File Watching | chokidar | Cross-platform file system watching |
| Bundler | Vite (frontend) + tsx (backend dev) | Fast, native ESM |

---

## 13. Implementation: The Kernel in Code

Uses the V2 TypeScript SDK (preview) for cleaner multi-turn sessions. See SDK-VERIFICATION.md for the full V1 vs V2 comparison.

```typescript
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  unstable_v2_prompt,
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// --- IPC Layer: Custom MCP tools backed by SQLite ---

const matrixOsIpc = createSdkMcpServer({
  name: "matrix-os-ipc",
  tools: [
    tool("list_tasks", "List tasks, optionally filtered by status", {
      status: z.enum(["pending", "in_progress", "completed", "failed"]).optional(),
    }, async (args) => { /* query SQLite */ }),
    tool("claim_task", "Claim a pending task for this agent", {
      task_id: z.string(),
    }, async (args) => { /* atomic UPDATE WHERE status='pending' */ }),
    tool("complete_task", "Mark task completed with output", {
      task_id: z.string(),
      output: z.string(),
    }, async (args) => { /* UPDATE status='completed', unblock deps */ }),
    tool("fail_task", "Mark task failed with error", {
      task_id: z.string(),
      error: z.string(),
    }, async (args) => { /* UPDATE status='failed' */ }),
    tool("send_message", "Send message to another agent or kernel", {
      to: z.string(),
      content: z.string(),
    }, async (args) => { /* INSERT into messages */ }),
    tool("read_messages", "Read unread messages for this agent", {},
      async () => { /* SELECT WHERE read=0, mark read */ }),
    tool("read_state", "Read current Matrix OS state", {},
      async () => { /* generate state from SQLite */ }),
  ],
});

// --- Core agent definitions ---

const coreAgents = {
  "builder": {
    description: "Generates apps and modules from natural language",
    prompt: builderPrompt,
    tools: ["Read", "Write", "Edit", "Bash", "Glob",
            "mcp__matrix-os-ipc__claim_task", "mcp__matrix-os-ipc__complete_task",
            "mcp__matrix-os-ipc__fail_task", "mcp__matrix-os-ipc__send_message"],
    model: "opus" as const,
  },
  "healer": {
    description: "Diagnoses and repairs broken apps and modules",
    prompt: healerPrompt,
    tools: ["Read", "Edit", "Bash", "Grep",
            "mcp__matrix-os-ipc__claim_task", "mcp__matrix-os-ipc__complete_task",
            "mcp__matrix-os-ipc__fail_task", "mcp__matrix-os-ipc__read_state"],
    model: "sonnet" as const,
  },
  "researcher": {
    description: "Researches libraries, APIs, and patterns",
    prompt: researcherPrompt,
    tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch",
            "mcp__matrix-os-ipc__send_message", "mcp__matrix-os-ipc__read_messages"],
    model: "haiku" as const,
  },
  "deployer": {
    description: "Deploys projects to hosting platforms",
    prompt: deployerPrompt,
    tools: ["Read", "Bash", "Glob",
            "mcp__matrix-os-ipc__claim_task", "mcp__matrix-os-ipc__complete_task"],
    model: "sonnet" as const,
  },
  "evolver": {
    description: "Modifies Matrix OS itself (with git safety)",
    prompt: evolverPrompt,
    tools: ["Read", "Write", "Edit", "Bash",
            "mcp__matrix-os-ipc__claim_task", "mcp__matrix-os-ipc__complete_task",
            "mcp__matrix-os-ipc__send_message"],
    model: "opus" as const,
  }
};

// --- Load custom agents from ~/agents/custom/*.md ---

async function loadCustomAgents(): Promise<Record<string, AgentDef>> {
  const files = await glob('~/agents/custom/*.md');
  const agents: Record<string, AgentDef> = {};
  for (const file of files) {
    const { frontmatter, body } = parseMarkdownWithFrontmatter(await readFile(file));

    // Resolve knowledge injection: read files, prepend to prompt
    let fullPrompt = body;
    if (frontmatter.inject?.length) {
      const knowledge = await Promise.all(
        frontmatter.inject.map((k: string) => readFile(`~/agents/knowledge/${k}.md`))
      );
      fullPrompt = knowledge.join('\n\n---\n\n') + '\n\n---\n\n' + body;
    }

    agents[frontmatter.name] = {
      description: frontmatter.description,
      prompt: fullPrompt,
      tools: frontmatter.tools ?? ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      model: frontmatter.model ?? "inherit",
    };
  }
  return agents;
}

// --- Kernel session options (shared between create and resume) ---

function kernelOptions(systemPrompt: string, allAgents: Record<string, AgentDef>) {
  return {
    model: "claude-opus-4-6",
    // System prompt: custom string built from OS files.
    // Uses custom prompt (not preset) because the OS has its own identity.
    // Sub-agents may use preset: "claude_code" when they need standard tool behavior.
    systemPrompt,
    allowedTools: [
      "Read", "Write", "Edit", "Bash",
      "Glob", "Grep", "WebSearch", "WebFetch", "Task",
      "mcp__matrix-os-ipc__*",  // All IPC tools (wildcard)
    ],
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    agents: allAgents,
    mcpServers: {
      "matrix-os-ipc": matrixOsIpc,
    },
    hooks: {
      PostToolUse: [
        { matcher: "Write|Edit", hooks: [updateStateHook, notifyShellHook, gitSnapshotHook] },
        { matcher: "Bash", hooks: [safetyGuardHook, logActivityHook] },
      ],
      SubagentStop: [{ hooks: [onSubagentComplete] }],
      Stop: [{ hooks: [persistSessionHook] }],
    },
  };
}

// --- Spawn or resume a kernel instance ---

async function spawnKernel(userMessage: string, sessionId?: string) {
  const processId = registerProcess(userMessage);
  const systemPrompt = await buildSystemPrompt();
  const customAgents = await loadCustomAgents();
  const allAgents = { ...coreAgents, ...customAgents };
  const opts = kernelOptions(systemPrompt, allAgents);

  // Create or resume session (V2 SDK)
  const session = sessionId
    ? unstable_v2_resumeSession(sessionId, opts)
    : unstable_v2_createSession(opts);

  try {
    // Send user message
    await session.send(userMessage);

    // Stream response back to gateway
    let newSessionId: string | undefined;
    for await (const msg of session.stream()) {
      newSessionId = msg.session_id;

      if (msg.type === "assistant") {
        // Stream text to shell UI via WebSocket
        const text = msg.message.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (text) broadcastToShell({ type: "assistant_text", text });
      }

      if (msg.type === "result") {
        if (msg.subtype === "success") {
          return { result: msg.result, sessionId: newSessionId, cost: msg.total_cost_usd };
        }
        // Handle turn limits, budget limits, errors
        return { error: msg.subtype, sessionId: newSessionId, cost: msg.total_cost_usd };
      }
    }
  } finally {
    // Save session for hibernate, deregister process
    if (newSessionId) await saveSessionId(newSessionId);
    session.close();
    deregisterProcess(processId);
  }
}
```

The kernel loads all agents dynamically at spawn time. Core agents are built-in with per-agent model selection (Opus for builder/evolver, Sonnet for healer/deployer, Haiku for researcher). Custom agents are markdown files with knowledge injection via the `inject` frontmatter field. The kernel can create new custom agents by writing new files to `~/agents/custom/`, making the agent pool self-expanding.

The IPC layer (task list + messaging) runs as an in-process MCP server backed by SQLite. Agents interact with it through typed tools (`claim_task`, `complete_task`, `send_message`, etc.) rather than raw file I/O.

The system prompt is fully custom (built from OS files), not the Claude Code preset. Sub-agents that need standard Claude Code tool behavior can use `preset: "claude_code"` with `append` for their specific instructions -- this is decided per-agent at spawn time.

---

## 14. Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                        USER LAYER                             │
│       Voice  |  Web Chat  |  Terminal  |  API  |  MCP        │
└──────────┬──────────┬──────────┬──────────┬──────────┬───────┘
           │          │          │          │          │
           ▼          ▼          ▼          ▼          ▼
┌──────────────────────────────────────────────────────────────┐
│                    GATEWAY / DISPATCHER                        │
│                                                                │
│  Receives messages from all channels.                         │
│  Spawns kernel instances. Non-blocking.                       │
│  Multiple requests -> multiple concurrent kernels.            │
│  Routes responses back to originating channel.                │
└─────────────┬──────────────┬──────────────┬──────────────────┘
              │              │              │
              ▼              ▼              ▼
       ┌────────────┐ ┌────────────┐ ┌────────────┐
       │  Kernel 1  │ │  Kernel 2  │ │ Heartbeat  │
       │            │ │            │ │  Kernel    │
       │ Smart agent│ │ Smart agent│ │            │
       │ Full tools │ │ Full tools │ │ Health     │
       │ Own context│ │ Own context│ │ checks,    │
       │            │ │            │ │ scheduled  │
       │ May fork:  │ │ Handles    │ │ tasks      │
       │ builder,   │ │ directly   │ │            │
       │ healer,    │ │ (fast)     │ │            │
       │ etc.       │ │            │ │            │
       └─────┬──────┘ └─────┬──────┘ └──────┬─────┘
             │              │               │
             └──────────────┼───────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                    SHARED FILE SYSTEM                          │
│                                                                │
│  ~/system/       State, config, theme, layout, processes      │
│  ~/agents/       System prompt, knowledge, memory, heartbeat  │
│  ~/apps/         HTML apps (rendered by shell as iframes)     │
│  ~/modules/      Structured modules with manifests            │
│  ~/projects/     Full codebases                               │
│  ~/data/         User data                                    │
│  ~/tools/        Scripts and automation                       │
│  ~/sessions/     Conversation archives                        │
│  ~/templates/    Reusable templates                           │
│  ~/themes/       Theme presets                                │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                    WEB SHELL (DESKTOP)                         │
│                                                                │
│  Watches file system. Renders what it finds.                  │
│  New file in ~/apps/ -> new window on desktop.                │
│  File changes -> display updates. Theme changes -> re-skin.  │
│                                                                │
│  Desktop canvas | App windows (iframes) | Chat panel          │
│  Activity feed | Module graph | Dock | Terminal | Editor      │
│                                                                │
│  The shell is optional. The OS works headlessly.              │
└──────────────────────────────────────────────────────────────┘
```

---

## 15. Safety

| Mechanism | What It Protects |
|-----------|-----------------|
| Git snapshots before mutations | All AI-initiated file changes can be rolled back |
| Watchdog process | If OS crashes after self-modification, revert and restart |
| Protected files list | Core kernel and config require user confirmation to modify |
| Module backup before healing | cp -r before patch; restore on test failure |
| Optimistic concurrency | Multiple kernels don't corrupt shared state |
| File-level claiming | processes.json declares which paths each kernel is touching |
| `git tag demo-safe` | Nuclear rollback before demo recording |

---

## 16. Demo Narrative (3 minutes)

### Act 1: Genesis (0:00 - 0:45)
- Empty Matrix OS desktop -- clean canvas
- "I need to track my daily expenses"
- Builder sub-agent generates expense-web + expense-data
- App window appears on the desktop, fully functional

### Act 2: Composition (0:45 - 1:30)
- "Add a CLI tool to log expenses from terminal"
- Builder creates expense-cli, wired to the same data
- Demo in terminal: `expense add 45 "Groceries"` -> appears in web app
- Module graph shows the growing architecture

### Act 3: Self-Healing (1:30 - 2:15)
- Intentionally break the expense web app (corrupt a query)
- Health check detects failure
- Healer diagnoses, patches, restarts
- App comes back to life. "It healed itself."

### Act 4: Self-Evolution (2:15 - 2:45)
- "Add a dark mode toggle to the dashboard"
- Evolver modifies the OS shell code
- Toggle appears. Click it. Everything goes dark.
- "Matrix OS just modified its own interface."

### Act 5: The Big Picture (2:45 - 3:00)
- Full desktop: apps, terminal, chat, module graph, activity feed
- "This started as an empty canvas."
- "Every piece was built by describing what we needed."
- "When something broke, it fixed itself."
- "When we wanted more, it built more -- including itself."
- "This is Matrix OS."

---

## 17. What Makes This Different

| Existing Tool | What It Does | What Matrix OS Adds |
|--------------|-------------|-------------------|
| bolt.new / bolt.diy | Generates disposable apps from prompts | Persistence. Composition. Self-healing. It's an OS, not a generator. |
| Cursor / Windsurf | AI-assisted code editing | Not an editor. A runtime. Software exists without a developer. |
| OpenClaw / Nanobot | Personal AI agent, orchestrates tools | Doesn't just orchestrate -- generates the tools themselves. |
| ChatGPT Canvas | AI generates code in a sidebar | No runtime. No persistence. No self-healing. No desktop. |
| Traditional OS | Static platform for pre-built software | Software doesn't exist until you need it. The OS builds it. |

Matrix OS is the first system where the AI agent IS the kernel, files ARE the state, and software is generated, composed, healed, and evolved in real time through natural language.
