# 061: Hermes Agent Integration

> Install Hermes Agent (Nous Research) as a second AI kernel in Matrix OS, giving users multi-model chat, self-improving skills, and 16+ channel adapters -- all MIT licensed.

## Source

- **Repo**: `../hermes-agent` (local clone of [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent))
- **License**: MIT
- **Version**: v0.8.0
- **Language**: Python 3.11+
- **Lines of code**: ~9,700 in `run_agent.py`, 762 Python files total

## Context

Matrix OS currently uses Claude Agent SDK as its only AI kernel. This works well for Claude-native users but limits model choice. Hermes Agent is a production-ready, MIT-licensed AI agent framework by Nous Research that supports 200+ models via OpenRouter, has a closed learning loop (skills self-improve during use), and ships with 16+ channel adapters.

Rather than forking, we install Hermes as a Python sidecar process and expose it through Matrix OS's shell and gateway. Users get a "Hermes" chat app alongside the existing Claude chat, can run `hermes` in the terminal, and can connect external channels (Telegram, Discord, Matrix protocol, etc.) through Hermes's own gateway.

### Why Hermes specifically

| Capability | Matrix OS (Claude SDK) | Hermes adds |
|---|---|---|
| Models | Claude only | 200+ via OpenRouter, Nous Portal, OpenAI, z.ai, Kimi, MiniMax |
| Skill evolution | Static markdown skills | Skills self-improve during use, agent creates new skills from experience |
| Memory | SQLite/Drizzle | FTS5 full-text search + LLM summarization across sessions |
| Context compression | None | Structured summary with head/tail protection, iterative updates |
| Channel adapters | Telegram, Discord (basic) | 16+ platforms including Matrix protocol with E2EE |
| Prompt caching | Manual cache_control | Automatic system_and_3 strategy (~75% cost reduction on Anthropic) |
| Subagent delegation | Claude Agent tool | Isolated child agents with restricted toolsets, parallel batch mode |
| ACP protocol | No | Agent Client Protocol support (standardized agent interop) |
| Model routing | Fixed | Smart cheap/strong routing based on message complexity |
| Credential pool | Single key | Multi-credential failover with round-robin/least-used strategies |
| Security scanning | PreToolUse hooks | Prompt injection detection, SSRF guards, skill security scanning |

## Architecture Overview

```
Matrix OS Container
  |
  +-- Node.js (gateway :4000 + shell :3000)
  |     |
  |     +-- Claude Agent SDK kernel (existing)
  |     +-- Hermes HTTP client -> Hermes API
  |
  +-- Python sidecar (Hermes Agent)
        |
        +-- API server (:8642) -- OpenAI-compatible
        +-- Gateway process (optional, for external channels)
        +-- ACP adapter (for standardized agent protocol)
```

The Hermes process runs alongside Node.js. Matrix OS talks to it via its OpenAI-compatible HTTP API (`/v1/chat/completions`, `/v1/responses`, `/v1/runs`). No Python code runs inside the Node.js process.

## Goals

1. Users can install Hermes Agent from Matrix OS settings
2. "Hermes Chat" app in the shell for multi-model conversations
3. `hermes` TUI accessible in the Matrix OS terminal
4. External channels configurable through Hermes gateway
5. Matrix protocol integration via Hermes's `nio` adapter
6. Skills and memory persist in the user's home directory

## Non-Goals

- Replacing Claude Agent SDK as the primary kernel
- Merging the two agent runtimes into one process
- Porting Hermes to TypeScript (too large, evolving upstream)
- Running Hermes tools from the Claude kernel (separate tool registries)

---

## Hermes Agent Deep Reference

> This section is a complete map for any coding agent tasked with building this integration. Everything below was read directly from the source at `../hermes-agent`.

### Project Structure

```
hermes-agent/
  run_agent.py              # AIAgent class (9,700 lines) -- the core orchestrator
  model_tools.py            # Tool registry loader, get_tool_definitions()
  cli.py                    # Interactive TUI entry point
  hermes_constants.py       # get_hermes_home(), path helpers
  utils.py                  # Shared utilities
  toolsets.py               # Toolset grouping definitions
  batch_runner.py           # Batch trajectory generation
  mcp_serve.py              # MCP server mode

  agent/                    # Extracted internals from run_agent.py
    __init__.py             # Module docstring only
    anthropic_adapter.py    # Native Anthropic API adapter (not via OpenAI SDK)
    auxiliary_client.py     # Cheap model LLM calls (for summarization, etc.)
    builtin_memory_provider.py  # MEMORY.md + USER.md as MemoryProvider
    context_compressor.py   # Auto context compression with structured summaries
    context_references.py   # Reference file injection (AGENTS.md, .cursorrules)
    copilot_acp_client.py   # Copilot/ACP client bridge
    credential_pool.py      # Multi-credential failover pool
    display.py              # Terminal display formatting
    error_classifier.py     # API error classification + failover decisions
    insights.py             # Usage analytics and insights
    memory_manager.py       # Orchestrates builtin + one external memory provider
    memory_provider.py      # MemoryProvider abstract interface
    model_metadata.py       # Model context lengths, token estimation
    models_dev.py           # Development model configurations
    prompt_builder.py       # System prompt assembly (identity, skills TOC, context files)
    prompt_caching.py       # Anthropic cache_control injection (system_and_3)
    rate_limit_tracker.py   # Rate limit tracking and backoff
    redact.py               # PII/secret redaction
    retry_utils.py          # Jittered backoff utilities
    skill_commands.py       # Skill slash command handling
    skill_utils.py          # Skill frontmatter parsing, platform filtering
    smart_model_routing.py  # Cheap vs strong model selection by message complexity
    subdirectory_hints.py   # Working directory context hints
    title_generator.py      # Conversation title generation
    trajectory.py           # Training trajectory recording
    usage_pricing.py        # Token cost calculation

  gateway/                  # Messaging gateway
    run.py                  # GatewayRunner -- starts all platform adapters
    config.py               # GatewayConfig, Platform enum, HomeChannel, SessionResetPolicy
    session.py              # Session management, PII redaction, session keys
    delivery.py             # Cron output routing to platforms
    hooks.py                # Pre/post message hooks
    mirror.py               # Message mirroring across platforms
    stream_consumer.py      # Streaming response consumer
    sticker_cache.py        # Telegram sticker caching
    pairing.py              # Device/user pairing flow
    channel_directory.py    # Channel discovery
    status.py               # Gateway status reporting
    builtin_hooks/          # Built-in pre/post hooks
    platforms/              # Channel adapters (see below)

  tools/                    # 50+ tool modules
    registry.py             # Central ToolRegistry singleton
    terminal_tool.py        # Shell command execution (6 backends)
    file_tools.py           # File read/write/search
    browser_tool.py         # Web browsing (Playwright, Browserbase, Firecrawl)
    memory_tool.py          # MEMORY.md / USER.md read/write
    skills_tool.py          # Skill listing and viewing (progressive disclosure)
    skill_manager_tool.py   # Agent-managed skill CRUD
    delegate_tool.py        # Subagent spawning (parallel batch mode)
    cronjob_tools.py        # Cron job management with prompt injection scanning
    mcp_tool.py             # MCP server integration
    session_search_tool.py  # FTS5 cross-session search
    web_tools.py            # Web search (Exa, Tavily, parallel-web)
    vision_tools.py         # Image analysis
    voice_mode.py           # Voice input/output
    tts_tool.py             # Text-to-speech (Edge TTS, ElevenLabs)
    transcription_tools.py  # STT (faster-whisper)
    send_message_tool.py    # Cross-platform message sending
    todo_tool.py            # Task management
    clarify_tool.py         # Ask user for clarification
    image_generation_tool.py # Image generation (fal.ai)
    code_execution_tool.py  # Sandboxed code execution
    homeassistant_tool.py   # Home Assistant integration
    mixture_of_agents_tool.py # Multi-model consensus
    rl_training_tool.py     # RL trajectory tools (Atropos)
    openrouter_client.py    # OpenRouter API client
    budget_config.py        # Spending budget/limits
    url_safety.py           # URL safety checking
    tirith_security.py      # Security policy enforcement
    approval.py             # Tool approval flow
    process_registry.py     # Background process tracking
    environments/           # Terminal backends
      local.py              # Local shell
      docker.py             # Docker containers
      ssh.py                # Remote SSH
      daytona.py            # Daytona serverless
      modal.py              # Modal serverless
      singularity.py        # Singularity containers

  acp_adapter/              # Agent Client Protocol adapter
    server.py               # HermesACPAgent -- ACP server wrapping AIAgent
    session.py              # SessionManager for ACP sessions
    auth.py                 # Provider detection for ACP auth
    events.py               # ACP event callbacks (message, thinking, tool progress)
    permissions.py          # ACP permission/approval bridge
    entry.py                # Entry point
    tools.py                # ACP tool exposure

  cron/                     # Cron scheduler
    jobs.py                 # Job CRUD (create, list, pause, resume, trigger)
    scheduler.py            # APScheduler-based cron execution

  hermes_cli/               # CLI and configuration
    main.py                 # CLI entry point (fire-based)
    config.py               # Config loading (config.yaml + .env)
    models.py               # Model listing and selection
    providers.py            # Provider registry and auth
    auth.py                 # OAuth, API key management
    gateway.py              # Gateway CLI commands
    setup.py                # Interactive setup wizard
    doctor.py               # Diagnostic tool
    default_soul.py         # Default SOUL.md template
    env_loader.py           # .env file loading
    skills_config.py        # Skill enable/disable
    tools_config.py         # Tool enable/disable
    profiles.py             # Multi-profile support
    plugins.py              # Plugin system
    skin_engine.py          # TUI theming

  skills/                   # 26 bundled skill categories
    apple/                  # macOS integration
    autonomous-ai-agents/   # Agent building
    creative/               # Creative writing
    data-science/           # Data analysis
    devops/                 # DevOps tasks
    github/                 # GitHub integration
    media/                  # Media processing
    mlops/                  # ML operations
    note-taking/            # Note organization
    productivity/           # Productivity workflows
    research/               # Research tasks
    software-development/   # Coding skills
    ... (26 categories total)

  optional-skills/          # Additional installable skills
  plugins/                  # Plugin system
  docker/                   # Docker configurations
```

### Core Classes and Entry Points

#### AIAgent (`run_agent.py`)

The main orchestrator. 9,700 lines. Key methods:

```python
class AIAgent:
    def __init__(self, base_url, model, api_key=None, ...):
        # Initializes OpenAI client, tool registry, memory, skills
        self.client = OpenAI(base_url=base_url, api_key=api_key)

    def run_conversation(self, user_message, conversation_history=None, task_id=None):
        # Main conversation loop:
        # 1. Build system prompt (identity + skills TOC + memory + context files)
        # 2. Call LLM with tools
        # 3. Execute tool calls
        # 4. Loop until no more tool calls or max iterations
        # 5. Post-turn: sync memory, queue prefetch, check skill creation nudge
        # Returns: {"final_response": str, "messages": list, "usage": dict}

    def _build_system_prompt(self):
        # Assembles: identity (SOUL.md) + skills index + memory blocks + context refs

    def _compress_context(self, messages, system_prompt, approx_tokens, task_id):
        # Delegates to ContextCompressor for structured summarization
```

#### GatewayRunner (`gateway/run.py`)

Starts platform adapters, manages lifecycle:

```python
class GatewayRunner:
    async def start(self):
        # 1. Load config (config.yaml)
        # 2. Initialize platform adapters based on config
        # 3. Start each adapter (connect to platform APIs)
        # 4. Start cron scheduler
        # 5. Start API server if enabled
        # Run until shutdown signal

    async def handle_message(self, message: MessageEvent):
        # 1. Session lookup/create
        # 2. Build session context
        # 3. Call AIAgent.run_conversation()
        # 4. Stream/send response back to platform
```

#### API Server (`gateway/platforms/api_server.py`)

OpenAI-compatible HTTP server on port 8642:

```
POST /v1/chat/completions     -- Chat Completions (stateless or session-aware)
POST /v1/responses            -- Responses API (stateful via previous_response_id)
GET  /v1/responses/{id}       -- Retrieve stored response
DELETE /v1/responses/{id}     -- Delete stored response
GET  /v1/models               -- List available model
POST /v1/runs                 -- Start async run (returns 202 + run_id)
GET  /v1/runs/{id}/events     -- SSE stream of run lifecycle events
GET  /health                  -- Health check
```

**This is the primary integration surface for Matrix OS.** The shell's Hermes chat app talks to this API. Auth is via `X-Hermes-Token` header or configurable bearer token.

Session continuity: pass `X-Hermes-Session-Id` header to maintain conversation state across requests. Without it, each request is stateless.

### Platform Adapters

All inherit from `BasePlatformAdapter` (`gateway/platforms/base.py`):

```python
class BasePlatformAdapter(ABC):
    @abstractmethod
    async def connect(self): ...           # Connect to platform API
    @abstractmethod
    async def disconnect(self): ...        # Graceful shutdown
    @abstractmethod
    async def send_message(self, chat_id, text, ...) -> SendResult: ...
    # Optional: send_image, send_file, send_reaction, edit_message
```

**Supported platforms** (enum in `gateway/config.py`):

| Platform | Adapter file | Auth mechanism | Notes |
|---|---|---|---|
| Telegram | `telegram.py` | Bot token (`TELEGRAM_BOT_TOKEN`) | Groups, reactions, voice, stickers, document handling |
| Discord | `discord.py` | Bot token (`DISCORD_BOT_TOKEN`) | Slash commands, threads, voice, reactions, approval buttons |
| WhatsApp | `whatsapp.py` | Cloud API (`WHATSAPP_TOKEN`) | Business API, group gating |
| Slack | `slack.py` | Bot/app tokens (`SLACK_BOT_TOKEN`) | Bolt framework, approval buttons |
| Signal | `signal.py` | Signal CLI bridge | Via signal-cli REST API |
| Matrix | `matrix.py` | Access token (`MATRIX_ACCESS_TOKEN`) | matrix-nio SDK, E2EE support, threads |
| Mattermost | `mattermost.py` | Personal access token | WebSocket + REST API |
| Email | `email.py` | IMAP/SMTP credentials | Inbound email parsing |
| SMS | `sms.py` | Twilio API | Via Twilio |
| DingTalk | `dingtalk.py` | App credentials | Chinese enterprise messaging |
| Feishu | `feishu.py` | App credentials | Lark/Feishu (ByteDance) |
| WeCom | `wecom.py` | Corp credentials | WeChat Work |
| BlueBubbles | `bluebubbles.py` | Server URL + password | iMessage bridge |
| Home Assistant | `homeassistant.py` | Long-lived access token | Smart home control |
| Webhook | `webhook.py` | Custom | Dynamic webhook routes |
| API Server | `api_server.py` | Bearer token | OpenAI-compatible HTTP API |

### Data Directory Layout (`HERMES_HOME`)

Default: `~/.hermes/` (overridable via `HERMES_HOME` env var)

```
~/.hermes/
  config.yaml             # Main config (model, provider, tools, gateway platforms)
  .env                    # API keys and secrets
  SOUL.md                 # Agent identity/personality (like Matrix OS's soul.md)
  MEMORY.md               # Agent's persistent memory (factual knowledge)
  USER.md                 # User profile (preferences, context)
  sessions/               # Conversation history (JSON per session)
  skills/                 # User-created and installed skills
    my-skill/
      SKILL.md            # Frontmatter + instructions
      references/         # Supporting docs
      templates/          # Output templates
      assets/             # Other files
  cache/
    images/               # Downloaded platform images
  cron/
    jobs.json             # Cron job definitions
  platforms/
    matrix/
      store/              # E2EE keys and sync state
  response_store.db       # SQLite -- Responses API state
  memory.db               # SQLite -- FTS5 session search index
```

### Configuration (`config.yaml`)

```yaml
model: "anthropic/claude-sonnet-4-20250514"
provider: openrouter
# OR
# model: "hermes-3-llama-3.1-405b"
# provider: nous

gateway:
  platforms:
    telegram:
      enabled: true
      bot_token: "${TELEGRAM_BOT_TOKEN}"  # Resolved from .env
      allowed_users: ["123456789"]
      home_channel: "123456789"
    discord:
      enabled: true
      bot_token: "${DISCORD_BOT_TOKEN}"
    matrix:
      enabled: true
      homeserver: "https://matrix-os.com"
      encryption: true
  api_server:
    enabled: true
    host: "127.0.0.1"
    port: 8642

memory:
  enabled: true
  user_profile: true
  # honcho:
  #   enabled: true   # Optional external memory provider

tools:
  enabled_toolsets:
    - terminal
    - file
    - web
    - memory
    - skills
    - delegate
    - cron
    - mcp
  disabled_toolsets: []

smart_routing:
  enabled: false
  cheap_model:
    provider: openrouter
    model: "meta-llama/llama-3.1-8b-instruct"

compression:
  enabled: true
  threshold_percent: 0.50

sessions:
  reset_policy: inactivity
  inactivity_timeout: 3600  # seconds
```

### Key Patterns Worth Copying to TypeScript

#### 1. Skill Self-Improvement (`tools/skill_manager_tool.py`)

Hermes creates skills from experience. After a complex multi-step task, the agent can autonomously create a new skill capturing the approach. Skills can be patched/edited during use when the agent discovers improvements.

```python
# Actions: create, edit, patch, delete, write_file, remove_file
# Skills stored in ~/.hermes/skills/<name>/SKILL.md
# Security scanning on every write (prompt injection, exfil patterns)
# Frontmatter: name, description, version, platforms, prerequisites
```

**Matrix OS equivalent**: `~/agents/skills/*.md` already exists but is static. Port the `skill_manager_tool` pattern to let the kernel agent create/edit skills.

#### 2. Context Compression (`agent/context_compressor.py`)

Structured summarization when approaching context limit:

1. Prune old tool results (cheap, no LLM call)
2. Protect head messages (system prompt + first exchange)
3. Protect tail messages by token budget (~20K tokens)
4. Summarize middle turns with structured template: Goal, Progress, Decisions, Files, Next Steps
5. On subsequent compressions, iteratively update previous summary

```python
SUMMARY_PREFIX = "[CONTEXT COMPACTION] Earlier turns were compacted..."
_MIN_SUMMARY_TOKENS = 2000
_SUMMARY_RATIO = 0.20  # 20% of compressed content allocated to summary
_SUMMARY_TOKENS_CEILING = 12_000
```

**Matrix OS equivalent**: Claude Agent SDK handles context internally, but this pattern is useful for Hermes sessions routed through Matrix OS.

#### 3. Memory System (`agent/memory_manager.py`, `tools/memory_tool.py`)

Two-file memory: `MEMORY.md` (factual knowledge) + `USER.md` (user profile). Injected into system prompt via `<memory-context>` fenced blocks with injection protection.

```python
# MemoryManager orchestrates builtin + max 1 external provider
# Builtin: file-backed MEMORY.md + USER.md
# External: Honcho dialectic modeling (optional)
# Prefetch: query-based recall before each turn
# Sync: post-turn memory updates
# Fencing: <memory-context> tags prevent model treating memory as user input
```

**Matrix OS equivalent**: Kernel has `memory.ts` and `memory-search.ts`. The fencing pattern and prefetch/sync lifecycle are worth adopting.

#### 4. Prompt Injection Detection (`agent/prompt_builder.py`)

Scans context files (AGENTS.md, .cursorrules, SOUL.md) for injection before loading:

```python
_CONTEXT_THREAT_PATTERNS = [
    (r'ignore\s+(previous|all|above|prior)\s+instructions', "prompt_injection"),
    (r'do\s+not\s+tell\s+the\s+user', "deception_hide"),
    (r'system\s+prompt\s+override', "sys_prompt_override"),
    (r'curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD)', "exfil_curl"),
    (r'cat\s+[^\n]*(\.env|credentials|\.netrc)', "read_secrets"),
    # ... 10 patterns total
]
# Also checks for invisible unicode characters (zero-width spaces, etc.)
```

**Matrix OS equivalent**: PreToolUse hooks do some of this. Port the pattern list for context file scanning.

#### 5. Smart Model Routing (`agent/smart_model_routing.py`)

Routes simple messages to a cheap model, complex ones to the primary:

```python
_COMPLEX_KEYWORDS = {"debug", "implement", "refactor", "analyze", "architecture", ...}
# Simple: < 200 chars, no code fences, no URLs, no complex keywords
# Complex: everything else -> primary model
```

#### 6. Credential Pool (`agent/credential_pool.py`)

Multi-key failover for same provider:

```python
# Strategies: fill_first, round_robin, random, least_used
# Auto-failover on rate limit or auth errors
# OAuth token refresh with TTL tracking
# Provider-specific URL resolution (Kimi, z.ai)
```

#### 7. Subagent Delegation (`tools/delegate_tool.py`)

Spawns isolated child AIAgent instances:

```python
# Each child gets: fresh conversation, own task_id, restricted toolset
# Blocked tools: delegate_task (no recursion), clarify, memory, send_message
# MAX_CONCURRENT_CHILDREN = 3
# MAX_DEPTH = 2 (parent -> child -> grandchild rejected)
# Parallel batch mode: submit multiple goals, run concurrently
```

#### 8. Tool Registry (`tools/registry.py`)

Centralized singleton registry with toolset grouping:

```python
class ToolRegistry:
    def register(self, name, toolset, schema, handler, check_fn=None, ...):
        # Called at module-import time by each tool file
    def deregister(self, name):
        # Used by MCP dynamic tool discovery
    def get_tools_for_toolsets(self, toolsets):
        # Returns filtered tool definitions
```

Toolsets group related tools: `terminal`, `file`, `web`, `memory`, `skills`, `delegate`, `cron`, `mcp`, `vision`, `voice`, `browser`, etc.

### Platform Adapter Interface

The key interface for channel integration:

```python
@dataclass
class MessageEvent:
    platform: Platform        # Which platform
    chat_id: str              # Platform-specific chat identifier
    sender_id: str            # Who sent it
    sender_name: str          # Display name
    text: str                 # Message text
    message_id: str           # Platform message ID
    thread_id: Optional[str]  # Thread/topic ID
    images: List[str]         # Local paths to attached images
    files: List[dict]         # Attached files
    audio: Optional[str]      # Voice message path
    is_group: bool            # Group vs DM
    reply_to: Optional[str]   # Quoted message ID
    timestamp: datetime
    raw: Any                  # Platform-specific raw event

class SendResult:
    success: bool
    message_id: Optional[str]
    error: Optional[str]
```

### Session Management (`gateway/session.py`)

```python
@dataclass
class SessionSource:
    platform: Platform
    chat_id: str
    sender_id: str
    sender_name: str
    thread_id: Optional[str]
    is_group: bool

def build_session_key(source: SessionSource) -> str:
    # Format: "platform:chat_id" or "platform:chat_id:thread_id"
    # Sessions are isolated per-chat (or per-thread in group contexts)
```

Reset policies: `inactivity` (reset after N seconds idle), `manual` (only on `/reset`), `always` (every message).

### Security Features

1. **Prompt injection scanning**: Context files, cron prompts, and skill content are scanned before injection
2. **SSRF protection**: URL safety checking in browser/web tools
3. **Skill security scanning**: Agent-created skills go through same security audit as community installs
4. **PII redaction**: Phone numbers and chat IDs are hashed in logs
5. **Invisible unicode detection**: Catches zero-width space injection attempts
6. **Tool approval flow**: Dangerous operations require explicit user approval
7. **Credential isolation**: Each session/child agent gets scoped credentials

---

## Integration Plan

### Phase 1: Hermes Process Manager

Add Hermes as a managed sidecar process in the gateway.

**New files:**
- `packages/gateway/src/hermes/process.ts` -- Start/stop/health-check the Hermes Python process
- `packages/gateway/src/hermes/client.ts` -- HTTP client for Hermes API (port 8642)
- `packages/gateway/src/hermes/config.ts` -- Config generation (config.yaml + .env from Matrix OS settings)

**How it works:**
1. Gateway checks if Hermes is installed (`which hermes` or check for Python package)
2. On startup (if enabled in settings), spawn `hermes gateway` as a child process
3. Health check via `GET /health` on port 8642
4. Restart on crash with exponential backoff
5. Graceful shutdown on gateway stop

**Config mapping** (Matrix OS settings -> Hermes config.yaml):
- Model selection -> `model` + `provider`
- API keys -> `.env` file
- Enabled platforms -> `gateway.platforms.*`
- Memory toggle -> `memory.enabled`

### Phase 2: Hermes Chat App

A built-in Matrix OS app that provides a chat UI for Hermes.

**Two surfaces:**

1. **Shell chat component** (`shell/src/components/hermes/HermesChat.tsx`)
   - SSE streaming from `/v1/chat/completions` with `stream: true`
   - Session continuity via `X-Hermes-Session-Id` header
   - Model picker (OpenRouter model list)
   - Skill browser panel
   - Memory viewer
   - Chat history (from Hermes sessions directory)

2. **Built-in module** (`~/modules/hermes-chat/`)
   - React app served through the gateway
   - Full-featured chat interface
   - Can be opened as a windowed app in the shell desktop

**API proxy** (gateway routes to avoid CORS):
```
POST /api/hermes/v1/chat/completions  -> localhost:8642/v1/chat/completions
POST /api/hermes/v1/responses         -> localhost:8642/v1/responses
GET  /api/hermes/v1/models            -> localhost:8642/v1/models
POST /api/hermes/v1/runs              -> localhost:8642/v1/runs
GET  /api/hermes/v1/runs/:id/events   -> localhost:8642/v1/runs/:id/events
GET  /api/hermes/health               -> localhost:8642/health
```

### Phase 3: Terminal Integration

Users run `hermes` in the Matrix OS xterm.js terminal and get the full Hermes TUI experience (multiline editing, slash commands, streaming, skill autocomplete).

This requires:
- Hermes CLI (`hermes` command) installed in the container PATH
- `HERMES_HOME` set to user's home directory (`~/` in Matrix OS)
- Python available in the container

### Phase 4: Channel Configuration

Settings UI for Hermes channel management:

- **Telegram**: Bot token input, allowed users, home channel
- **Discord**: Bot token, server selection
- **Matrix**: Homeserver URL, access token, E2EE toggle
- **Slack**: Bot/app token
- **WhatsApp**: Cloud API token
- **Others**: Generic credential input per platform

Settings writes to `~/system/hermes/config.yaml` and `~/system/hermes/.env`, then signals Hermes to reload.

### Phase 5: Matrix Protocol Bridge

Connect Hermes to Matrix homeserver for federated messaging:

- Hermes bot identity: `@hermes:matrix-os.com`
- E2EE support via `matrix-nio[e2e]`
- Users chat with their Hermes from any Matrix client
- Cross-room conversation continuity

## Docker Changes

The container needs Python alongside Node.js:

```dockerfile
# Add to existing Dockerfile
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv
# Install Hermes in isolated venv
RUN python3 -m venv /opt/hermes-venv
RUN /opt/hermes-venv/bin/pip install hermes-agent[messaging,matrix,cron]
ENV PATH="/opt/hermes-venv/bin:${PATH}"
```

Estimated additional image size: ~400MB (Python + Hermes deps).
Estimated additional RAM: ~250MB idle, ~500MB active.

## Settings Schema

```typescript
interface HermesSettings {
  enabled: boolean;
  model: string;              // e.g. "anthropic/claude-sonnet-4-20250514"
  provider: string;           // e.g. "openrouter", "nous", "openai"
  apiKeys: {
    openrouter?: string;
    openai?: string;
    anthropic?: string;
    nous?: string;
  };
  memory: {
    enabled: boolean;
    userProfile: boolean;
  };
  smartRouting: {
    enabled: boolean;
    cheapModel?: string;
  };
  gateway: {
    platforms: Record<string, {
      enabled: boolean;
      credentials: Record<string, string>;
      homeChannel?: string;
      allowedUsers?: string[];
    }>;
  };
}
```

Stored in `~/system/config.json` under a `hermes` key (Everything Is a File).

## Open Questions

1. **Install mechanism** -- Bundled in Docker image, or user-triggered install via `pip install hermes-agent`? Bundling is simpler but adds ~400MB. On-demand install saves space but adds first-run latency.

2. **Shared home directory** -- Should Hermes use the same `~/` as Matrix OS (so files are visible to both kernels), or an isolated `~/hermes/`? Shared is more useful but risks conflicts.

3. **Hermes version pinning** -- Pin to v0.8.0 or track upstream? Hermes is pre-1.0 and evolving fast. Pinning gives stability but misses improvements.

4. **Skill sharing** -- Can Matrix OS skills and Hermes skills share format? Both use markdown with YAML frontmatter, but the fields differ. A compatibility layer could let skills work in both systems.

5. **Unified conversation history** -- Should Hermes conversations appear in the Matrix OS chat history alongside Claude conversations? Different backends but same UI.
