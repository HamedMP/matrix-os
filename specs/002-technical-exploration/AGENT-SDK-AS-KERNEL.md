# Technical Exploration: Claude Agent SDK as the OS Kernel

## The Core Idea

Traditional operating systems have a kernel written in C/Rust that manages hardware, memory, processes, and file systems. Matrix OS has a different kind of kernel: the Claude Agent SDK.

The Agent SDK has full control over the machine:
- Read, write, edit, delete any file
- Run any terminal command, script, git operation
- Find files by pattern, search contents with regex
- Search the web, fetch web pages
- Connect to external services via MCP
- Spawn sub-agents for parallel work
- Ask the user clarifying questions

This IS an operating system kernel -- it manages resources, carries out user intent, and maintains system state. The difference is that it understands natural language instead of system calls.

```
Traditional OS:                    Matrix OS:
User -> GUI -> System Call -> Kernel   User -> Voice/Chat -> Agent SDK -> File System
                    |                                           |
              Hardware/FS                                 Hardware/FS
```

## The Claude Agent SDK

The Claude Agent SDK (formerly Claude Code SDK) gives us Claude Code as a library. Same tools, same agent loop, same context management -- but programmable.

### Built-in Tools

| Tool | What it does |
|------|--------------|
| **Read** | Read any file in the working directory |
| **Write** | Create new files |
| **Edit** | Make precise edits to existing files |
| **Bash** | Run terminal commands, scripts, git operations |
| **Glob** | Find files by pattern |
| **Grep** | Search file contents with regex |
| **WebSearch** | Search the web |
| **WebFetch** | Fetch and parse web page content |
| **AskUserQuestion** | Ask clarifying questions with options |
| **Task** | Spawn sub-agents for focused subtasks |

These are Matrix OS's system calls. The agent uses them to do everything.

### Key Capabilities for Matrix OS

**Sub-agents:** Spawn specialized agents with different prompts and tool sets.
```typescript
agents: {
  "app-builder": {
    description: "Generates applications from descriptions",
    prompt: "You build apps for Matrix OS...",
    tools: ["Read", "Write", "Edit", "Bash", "Glob"]
  },
  "healer": {
    description: "Diagnoses and fixes broken applications",
    prompt: "You diagnose and repair Matrix OS apps...",
    tools: ["Read", "Edit", "Bash", "Grep"]
  }
}
```

**Hooks:** Run custom code at key lifecycle points.
```typescript
hooks: {
  PostToolUse: [{
    matcher: "Edit|Write",
    hooks: [async (input) => {
      // Log every file mutation for the shell to pick up
      // Trigger file watcher notification
      // Git snapshot if modifying system files
    }]
  }]
}
```

**MCP Integration:** Connect to external services.
```typescript
mcpServers: {
  playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
  github: { command: "npx", args: ["@modelcontextprotocol/server-github"] },
  calendar: { command: "npx", args: ["@anthropic/mcp-server-gcal"] }
}
```

**Sessions:** Maintain context across interactions. Resume conversations.
```typescript
// First interaction
const sessionId = captureSessionId(query({ prompt: "Build me a CRM" }));

// Later: resume with full context
query({ prompt: "Add a pipeline view to the CRM", options: { resume: sessionId } });
```

**Skills:** Markdown-based capabilities loaded from files.
```
.claude/skills/SKILL.md -> loaded into agent context
```

This maps directly to our `~/agents/knowledge/*.md` pattern.

## Architecture: SDK as Kernel

```
+-----------------------------------------------------+
|                    User Layer                         |
|  Voice | Chat | Terminal | Telegram | Discord | API  |
+-----------------------------------------------------+
|                  Gateway / Message Bus                |
|  Routes all input to the agent, all output to shells |
+-----------------------------------------------------+
|                  Agent SDK (The Kernel)               |
|                                                       |
|  System Prompt: ~/agents/system-prompt.md            |
|  Knowledge: ~/agents/knowledge/*.md                  |
|  Memory: ~/agents/memory/*.md                        |
|  Session: ~/sessions/current.jsonl                   |
|                                                       |
|  Built-in Tools:                                     |
|  Read | Write | Edit | Bash | Glob | Grep            |
|  WebSearch | WebFetch | Task (sub-agents)            |
|                                                       |
|  MCP Servers:                                        |
|  Playwright | GitHub | Calendar | Custom...          |
|                                                       |
|  Hooks:                                              |
|  PostToolUse -> file watcher notifications           |
|  PostToolUse -> git snapshots for system files       |
|  Stop -> session persistence                         |
|                                                       |
|  Sub-agents:                                         |
|  app-builder | healer | researcher | deployer        |
+-----------------------------------------------------+
|                  File System (The State)              |
|                                                       |
|  ~/apps/          Generated applications             |
|  ~/projects/      Full codebases                     |
|  ~/data/          Structured data                    |
|  ~/system/        OS config, theme, layout           |
|  ~/agents/        Agent knowledge and memory         |
|  ~/sessions/      Conversation history (JSONL)       |
|  ~/tools/         Scripts, automation                |
|  ~/templates/     Reusable templates                 |
+-----------------------------------------------------+
|                  Shell Layer (The Display)            |
|                                                       |
|  Web Shell: watches ~/apps/, renders iframes         |
|  Terminal: direct shell access                       |
|  File Browser: navigates the file tree               |
|  (Shell is optional -- OS works headlessly too)      |
+-----------------------------------------------------+
```

## Why Agent SDK vs Custom Agent Loop

We could build a custom agent loop (like Nanobot does in ~200 lines, or OpenClaw does with PI agent core). But using the Claude Agent SDK directly:

1. **Same tools as Claude Code** -- battle-tested Read, Write, Edit, Bash, Glob, Grep
2. **Sub-agent spawning built in** -- parallel background agents for free
3. **MCP support native** -- connect to any MCP server without custom integration
4. **Hooks system** -- intercept tool calls for logging, safety, notifications
5. **Session management** -- resume conversations, fork sessions
6. **Skills system** -- markdown-based capabilities from files
7. **Anthropic maintains it** -- bug fixes, performance, new features
8. **Hackathon signal** -- "Built with Claude Agent SDK" is exactly what judges want to see

The SDK is the kernel. Our code is the OS layer on top: file system conventions, shell rendering, gateway routing, knowledge system, channels.

## What This Enables

Because the Agent SDK has full computer control, Matrix OS handles requests at any complexity:

**Simple:** "What's the weather?" -> web search, respond
**Medium:** "Track my expenses" -> generate HTML app, create data files
**Complex:** "Build a SaaS dashboard with auth" -> scaffold Next.js, set up DB, deploy
**System-level:** "Set up CI/CD for my project" -> create GitHub Actions, push to repo
**Self-modification:** "Add dark mode to the OS" -> edit shell CSS, update theme system

Same agent, same kernel, same tools. The complexity is in the agent's reasoning, not the architecture.

## Agent SDK + OpenClaw + Nanobot Patterns

Matrix OS combines the Agent SDK with proven patterns:

| Component | Source | Implementation |
|-----------|--------|---------------|
| Agent execution + tools | Claude Agent SDK | Built-in Read, Write, Edit, Bash, etc. |
| Sub-agents | Claude Agent SDK | Task tool for parallel work |
| MCP integration | Claude Agent SDK | Native MCP server connections |
| Hooks | Claude Agent SDK | PostToolUse for file watching, safety |
| Gateway routing | OpenClaw | Multi-channel input to single agent |
| Message bus | Nanobot | Pub/sub decoupling channels from core |
| Skills/knowledge | Agent SDK + OpenClaw | Markdown files in system prompt |
| Sessions | Agent SDK + OpenClaw | JSONL per channel/peer |
| Channels | OpenClaw | Telegram, Discord, Slack, etc. |
| Heartbeat | Nanobot | Periodic file check for proactive tasks |
| Memory | Nanobot | Long-term markdown + daily notes |
| Provider management | Nanobot | Metadata-driven registry |
| Plugins | OpenClaw | NPM packages with hooks |

## System Prompt Architecture

The Agent SDK's system prompt defines the OS. Assembled from files:

```
~/agents/
  system-prompt.md          # Core identity + behavior rules
  knowledge/
    app-generation.md       # How to generate apps (HTML, React, etc.)
    data-management.md      # How to structure data files
    theme-system.md         # How the theme and layout system works
    healing-strategies.md   # How to diagnose and fix broken things
    deployment.md           # How to deploy to various targets
    integrations.md         # How to wire MCP connections
  user-profile.md           # User preferences, context
  heartbeat.md              # Proactive tasks to check periodically
  memory/
    long-term.md            # Persistent observations and learnings
    2026-02-10.md           # Today's notes
```

The system prompt rebuilds on every interaction, pulling current state:
- What apps exist (ls ~/apps/)
- What projects exist (ls ~/projects/)
- Current theme and layout config
- All knowledge files
- Memory and daily notes

The agent always has full awareness of the OS state.

## Self-Evolution via the SDK

The most powerful aspect: the Agent SDK can modify the OS itself.

The agent can:
1. **Write new knowledge files** -> teach itself new patterns
2. **Edit the system prompt** -> change its own behavior
3. **Generate new tools as scripts** -> create commands in ~/tools/
4. **Modify the shell** -> improve the UI code
5. **Install software** -> add capabilities via Bash
6. **Create specialized sub-agents** -> multi-agent OS

Guardrails:
- Git snapshots before system file modifications (via PostToolUse hook)
- Protected files list (shell core, config core)
- Watchdog process for auto-rollback on crash
- User confirmation for destructive operations

## Implementation Sketch

```typescript
import { query, ClaudeAgentOptions, AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { buildSystemPrompt } from "./prompt-builder";
import { fileWatcherHook, gitSnapshotHook, safetyHook } from "./hooks";

// The Matrix OS kernel
async function runMatrixOS(userMessage: string, sessionId?: string) {
  const systemPrompt = await buildSystemPrompt();

  for await (const message of query({
    prompt: userMessage,
    options: {
      systemPrompt,
      resume: sessionId,
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep",
                     "WebSearch", "WebFetch", "Task"],
      permissionMode: "bypassPermissions",  // Agent has full control
      agents: {
        "app-builder": {
          description: "Generates applications from natural language",
          prompt: "You build apps for Matrix OS. Write to ~/apps/ for HTML apps, ~/projects/ for full codebases.",
          tools: ["Read", "Write", "Edit", "Bash", "Glob"]
        },
        "healer": {
          description: "Diagnoses and repairs broken applications",
          prompt: "You fix broken Matrix OS apps. Read the error, understand the code, write a fix.",
          tools: ["Read", "Edit", "Bash", "Grep"]
        },
        "deployer": {
          description: "Deploys applications to hosting services",
          prompt: "You deploy Matrix OS projects. Support Vercel, Cloudflare, Docker, etc.",
          tools: ["Read", "Bash", "Glob"]
        }
      },
      mcpServers: loadMcpServers('~/system/mcp/'),
      hooks: {
        PostToolUse: [
          { matcher: "Write|Edit", hooks: [fileWatcherHook, gitSnapshotHook] },
          { matcher: "Bash", hooks: [safetyHook] }
        ]
      }
    }
  })) {
    yield message;  // Stream to gateway -> channels -> user
  }
}
```

This is the entire kernel. Everything else is the OS layer:
- Gateway routing (which channel called, route response back)
- Message bus (pub/sub for channels)
- Shell rendering (watch files, render in browser)
- Session persistence (save JSONL)
- Heartbeat service (periodic proactive checks)

## Hackathon Demo Implications

The demo shows:
1. "Build me a budget tracker" -> HTML app appears in seconds (voice command)
2. "Make it a full React app with charts" -> scaffolds Next.js, installs deps, runs dev server
3. "Deploy it" -> pushes to Vercel, returns URL
4. "Something's broken" -> healer sub-agent diagnoses and fixes
5. "Add dark mode to the OS itself" -> agent modifies shell code, OS updates

All from voice/chat. All through the Agent SDK kernel. All producing files on disk.

The pitch: "Claude Agent SDK IS the operating system. Files are the state. The shell is just a window into what the agent builds."
