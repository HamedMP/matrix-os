# Technical Exploration: Nanobot Patterns for Matrix OS

Nanobot is an ultra-lightweight personal AI agent in ~3,510 lines of Python. Where OpenClaw is feature-rich and production-grade (430k+ lines), Nanobot is minimal and readable. Together, they give Matrix OS two reference points: what a full system looks like, and what the essential patterns are when you strip everything else away.

---

## What Nanobot IS

A personal AI agent that:
- Supports 9+ chat channels (Telegram, Discord, Slack, WhatsApp, Email, QQ, etc.)
- Multi-provider LLM support (Anthropic, OpenAI, DeepSeek, Gemini, local models)
- Persistent memory via markdown files
- Background subagents for parallel tasks
- Scheduled tasks via cron + heartbeat
- Skills system (markdown with frontmatter)
- File/shell/web tools

All in ~3.5k lines. No web UI, no dashboards, no complex infrastructure.

---

## Patterns Worth Adopting

### 1. Message Bus (Pub/Sub)

Nanobot's cleanest architectural choice. Channels are completely decoupled from the agent core via async queues.

```
Channel A ──publish──► Inbound Queue ──► Agent Loop
Channel B ──publish──►                        │
Channel C ──publish──►                        │
                                              ▼
Channel A ◄──subscribe── Outbound Queue ◄── Response
Channel B ◄──subscribe──
Channel C ◄──subscribe──
```

Why this matters for Matrix OS: the agent core never imports channel code. Channels never import agent code. Adding a new channel (voice, web shell, a new chat platform) means implementing a subscriber -- nothing else changes.

OpenClaw achieves similar decoupling through its gateway routing, but Nanobot's message bus is more explicit and easier to reason about.

**For Matrix OS:** Use a message bus as the central nervous system. Every gateway (voice, chat, terminal, Telegram, Discord, etc.) publishes to and subscribes from the bus. The agent loop is just another subscriber.

### 2. Bootstrap File System

Nanobot's agent personality and behavior are defined by workspace files, not hardcoded prompts:

```
workspace/
  SOUL.md          # Personality, tone, values
  AGENTS.md        # Agent instructions, capabilities
  USER.md          # User profile, preferences
  TOOLS.md         # Available tools documentation
  IDENTITY.md      # Name, version, identity
  HEARTBEAT.md     # Periodic tasks to check
  memory/
    MEMORY.md      # Long-term memory
    2026-02-10.md  # Daily notes
```

The system prompt is assembled from these files at runtime. Change SOUL.md, the agent changes personality. Change AGENTS.md, it changes behavior. No code changes needed.

**For Matrix OS:** This maps perfectly to our `~/agents/` directory:

```
~/agents/
  system-prompt.md      # Core behavior (like SOUL.md + AGENTS.md)
  knowledge/
    app-generation.md   # How to generate apps
    theme-system.md     # How themes work
    healing.md          # How to self-heal
  user-profile.md       # User preferences (like USER.md)
  heartbeat.md          # Proactive tasks (like HEARTBEAT.md)
  memory/
    long-term.md        # Persistent memory
    2026-02-10.md       # Daily notes
```

Everything that shapes the agent is a file. The agent can modify these files to evolve its own behavior.

### 3. Provider Registry (Metadata-Driven)

Nanobot's provider system is a flat registry of metadata. No if-elif chains, no factory patterns. Each provider is a data entry:

```python
PROVIDERS = (
    ProviderSpec(
        name="anthropic",
        keywords=["claude"],
        env_key="ANTHROPIC_API_KEY",
        api_base="https://api.anthropic.com",
        # ...
    ),
    ProviderSpec(
        name="openai",
        keywords=["gpt", "o1", "o3"],
        env_key="OPENAI_API_KEY",
        # ...
    ),
)
```

Adding a provider = adding one data entry. Detection is automatic (match by API key prefix, api_base keyword, or model name keyword).

**For Matrix OS:** Use metadata-driven provider resolution instead of imperative logic. Matrix OS primarily uses Claude, but should support any provider without code changes.

### 4. Progressive Skill Loading

Nanobot loads skills in two tiers to manage context window:
- **Always-loaded skills**: Full markdown content in system prompt
- **Available skills**: Only the name + description + file path

The agent sees "weather skill available at skills/weather/SKILL.md" and can use the `read_file` tool to load the full skill when needed.

**For Matrix OS:** Same pattern for agent knowledge. Core knowledge (app generation, theme system) loads fully. Extended knowledge (specific integration patterns, advanced techniques) loads as summaries with paths. Agent reads the full file when relevant.

### 5. Heartbeat System

Every 30 minutes, Nanobot wakes up and reads `HEARTBEAT.md`. If there are tasks listed, it executes them. Simple, file-based, no database.

```markdown
# Heartbeat Tasks

- Check if the weather forecast shows rain tomorrow, remind user
- Review inbox for urgent emails
```

Agent reads this, acts on it, updates the file.

**For Matrix OS:** Heartbeat is how the OS becomes proactive. The agent periodically checks `~/agents/heartbeat.md` for tasks. Users add tasks by editing the file or asking the agent. The agent removes tasks once completed.

This is simpler than a full cron system for most use cases, and more natural (it's a to-do list the agent checks periodically).

### 6. Subagent Spawning

Nanobot can spawn background subagents for long-running tasks:
- Limited tool set (no message, no spawn -- prevents infinite loops)
- No conversation history access (fresh context)
- Announces result back to main agent via the message bus
- Non-blocking -- main agent continues serving the user

**For Matrix OS:** Background subagents for:
- Generating complex apps (takes time, shouldn't block conversation)
- Self-healing (diagnose and fix in background)
- Proactive tasks from heartbeat
- Parallel research when the agent needs to explore multiple options

### 7. Workspace Abstraction

Everything in Nanobot is relative to a workspace path. The workspace contains all state: memory, skills, config, daily notes. This makes it trivial to:
- Back up the agent (copy the workspace)
- Move to another machine (copy the workspace)
- Have multiple agents (different workspaces)

**For Matrix OS:** The OS root (`~/`) IS the workspace. Everything the OS generates, stores, and configures lives under this root. Backup = copy the root. Share = share files from the root. This is already our "everything is a file" philosophy.

### 8. Tool Validation

Nanobot validates tool parameters against JSON Schema before execution. Type checking, required fields, enums, ranges, nested objects. Catches bad LLM output before it hits the tool handler.

Also has execution guards: shell tool blocks destructive commands (`rm -rf`, `dd`, fork bombs). File tool has optional workspace restriction.

**For Matrix OS:** Validate tool inputs before execution. Block destructive operations without explicit confirmation. Restrict file operations to the OS root by default.

---

## Nanobot vs OpenClaw: What Each Teaches

| Lesson | From Nanobot | From OpenClaw |
|--------|-------------|--------------|
| How to structure an agent | Message bus, clean loop, minimal deps | Gateway routing, streaming, failover |
| How to handle providers | Metadata-driven registry | Auth profiles with rotation + cooldown |
| How to do skills | Markdown + frontmatter, progressive loading | Same pattern, more sources + precedence |
| How to do sessions | JSONL, simple file-per-session | JSONL + metadata, atomic writes, compaction |
| How to do memory | MEMORY.md + daily notes | sqlite-vec embeddings, semantic search |
| How to do background tasks | Subagent via message bus | Subagent via session spawning |
| How to do proactive behavior | Heartbeat + HEARTBEAT.md | Cron service + scheduled jobs |
| How to do channels | Async pub/sub subscribers | Plugin-based channel adapters |
| How to do plugins | N/A (no plugin system) | Full NPM plugin SDK with hooks |
| How to do config | Single JSON + Pydantic validation | YAML/JSON + Zod validation + live reload |

**Matrix OS should combine:**
- Nanobot's simplicity of core patterns (message bus, bootstrap files, heartbeat)
- OpenClaw's depth of implementation (channels, plugins, streaming, memory)
- New capabilities neither has (generative OS, voice, file-based apps, self-healing, self-evolving)

---

## Architecture Influence on Matrix OS

Nanobot suggests a cleaner way to think about Matrix OS's core:

```
Layer 1: Message Bus (the nervous system)
  - All I/O flows through the bus
  - Channels publish inbound, subscribe outbound
  - Agent loop subscribes inbound, publishes outbound
  - File watcher publishes change events
  - Voice gateway publishes transcribed text

Layer 2: Agent Core (the brain)
  - Reads from inbound queue
  - Builds context from bootstrap files
  - Calls LLM with tools
  - Tool calls produce file mutations
  - Responses go to outbound queue

Layer 3: File System (the body)
  - Apps, data, config, themes, layout
  - Agent knowledge, memory, sessions
  - Everything the OS IS lives here
  - File changes trigger shell updates

Layer 4: Shell (the face)
  - Watches file system for changes
  - Renders apps in browser
  - Provides voice/chat/terminal UI
  - Purely reactive -- it draws what the file system contains

Layer 5: Channels (the ears and mouth)
  - Telegram, Discord, Slack, etc.
  - Each is a bus subscriber
  - Stateless -- session state lives in files
```

This layered model is cleaner than our original specs, which mixed concerns between "core engine," "runtime," "composer," etc. The message bus is the key simplification -- it replaces explicit routing with pub/sub.

---

## Key Files in Nanobot (for reference)

| File | Lines | What it does |
|------|-------|-------------|
| `nanobot/agent/loop.py` | ~200 | Core agent execution loop |
| `nanobot/bus/queue.py` | ~80 | Message bus (inbound/outbound queues) |
| `nanobot/agent/context.py` | ~150 | System prompt assembly from bootstrap files |
| `nanobot/agent/subagent.py` | ~80 | Background subagent spawning |
| `nanobot/agent/skills.py` | ~120 | Skill loading + progressive context |
| `nanobot/providers/registry.py` | ~100 | Metadata-driven provider resolution |
| `nanobot/session/manager.py` | ~100 | JSONL session persistence |
| `nanobot/agent/tools/registry.py` | ~120 | Tool registration + validation |
| `nanobot/services/heartbeat.py` | ~60 | Periodic heartbeat check |
| `nanobot/services/cron.py` | ~100 | Scheduled task execution |

Total agent core: ~1,100 lines. The rest is channels, tools, and CLI.

**This suggests Matrix OS's core agent loop could be similarly compact.** The complexity is in the OS layer (file-based apps, shell rendering, theme system, self-healing), not in the agent itself.
