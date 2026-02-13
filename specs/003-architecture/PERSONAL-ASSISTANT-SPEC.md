# Matrix OS -- Personal Assistant Specification

## The OS That Is Also Your Personal AI Assistant

**Phases**: 9 (SOUL + Skills), 10 (Channels), 11 (Cron + Heartbeat), 12 (Cloud Deployment)
**Date**: 2026-02-12
**Depends on**: FINAL-SPEC.md (Sections 10-11), plan.md, tasks.md
**Reference**: OpenClaw/Moltbot (v2026.2.9, MIT), Nanobot (v0.1.3, MIT)

---

## 1. The Expanded Vision

Matrix OS started as a visual operating system -- open a browser, describe what you need, software appears. That remains the core.

But an OS that only responds when you open a browser tab is half the picture. Your phone is always with you. Your Telegram is always open. Your Slack is where you work. The OS should be reachable from wherever you already are.

Matrix OS is now both:

1. **A visual operating system** -- browser desktop, app generation, self-healing, self-evolution (Phases 1-8)
2. **A personal AI assistant** -- reachable from Telegram, WhatsApp, Discord, Slack. Proactive (heartbeat, reminders). Has a personality (SOUL). Learns new skills. Always on. (Phases 9-12)

These are not two products stitched together. They share the same kernel, the same file system, the same conversation history, the same identity. A message sent via Telegram flows through the same dispatcher and kernel that handles a message typed in the web shell. The OS generates a module via the desktop, and you check on its status from your phone via WhatsApp.

### The Synthesis (Updated)

Matrix OS combines three ideas that haven't been fused before:

1. **Real-time software generation** (Imagine with Claude) -- applications born from conversation, ephemeral becomes persistent
2. **Personal AI agent** (OpenClaw/Moltbot) -- multi-channel, proactive, always on, persistent memory, full system access
3. **Traditional OS** -- file system as truth, processes, self-healing, self-evolution

The result: an operating system for your digital life that you can interact with visually (browser) or conversationally (messaging), that generates software, remembers everything, and proactively helps you.

---

## 2. User Stories

### US7: "The OS knows who it is and has a personality"

I open the OS for the first time. It introduces itself with a distinct personality -- helpful, direct, curious. When I ask it something, it responds consistently with that personality. I can edit `soul.md` to change how it communicates. I can make it formal for work, casual for personal use, or give it a name.

**Acceptance criteria:**
- `~/system/soul.md` defines identity: personality, values, communication style
- SOUL content is injected into every kernel prompt (L0 cache, never evicted)
- Editing `soul.md` changes the OS personality on next interaction
- Default SOUL is useful out of the box (not generic)

### US7b: "The OS can learn new skills"

I tell the OS "learn how to check my portfolio value." It creates a skill file at `~/agents/skills/portfolio.md` that describes how to check portfolio value (which APIs to call, how to format the response). Next time I ask "how's my portfolio?", the kernel loads this skill and executes it.

**Acceptance criteria:**
- Skills are markdown files at `~/agents/skills/*.md` with YAML frontmatter
- Kernel loads skill TOC into system prompt (names + descriptions)
- Kernel loads full skill body on demand when a matching request comes in
- Kernel can create new skills by writing files (self-expanding)
- Initial skills bundled: summarize, weather, reminder, skill-creator

### US8: "I can message the OS from Telegram"

I configure my Telegram bot token in `config.json`. I restart the gateway. I send a message to my bot from Telegram: "What modules are running?" The OS responds with a list of active modules, formatted for Telegram. The same conversation appears in the web shell's chat history.

**Acceptance criteria:**
- Telegram adapter connects via Bot API polling
- Messages from Telegram route through dispatcher to kernel
- Kernel responses are formatted for Telegram (MarkdownV2)
- `allowFrom` filtering restricts who can message the bot
- Conversation persists in `~/system/conversations/` (shared with web shell)
- `GET /api/channels/status` shows connection state

### US8b: "I can message the OS from WhatsApp"

I scan a QR code to link my WhatsApp. I send "build me a quick notes app" from WhatsApp. The OS builds it. I open the web desktop and see the new app there.

**Acceptance criteria:**
- WhatsApp adapter uses Baileys (QR code pairing)
- Auth state persists in `~/system/whatsapp-auth/`
- Messages route through same pipeline as Telegram
- QR code accessible via `GET /api/channels/whatsapp/qr`

### US8c: "I can message the OS from Discord"

I add the bot to my Discord server. I DM it or @mention it in a channel. It responds with properly formatted Discord messages (code blocks, embeds).

**Acceptance criteria:**
- Discord adapter uses discord.js with Gateway Intents
- Responds to DMs and @mentions
- Messages formatted with Discord markdown

### US8d: "I can message the OS from Slack"

I configure the bot in my Slack workspace using Socket Mode (no public URL needed). I DM it or @mention it. It responds with Slack-formatted messages.

**Acceptance criteria:**
- Slack adapter uses @slack/bolt in Socket Mode
- Responds to DMs and @mentions
- Messages formatted with Slack mrkdwn

### US9: "The OS reminds me to drink water every 2 hours"

I tell the OS "remind me to drink water every 2 hours." It creates a cron job. Every 2 hours, the heartbeat picks up the reminder and sends it to me via my preferred channel (Telegram, WhatsApp, or web).

**Acceptance criteria:**
- Cron jobs stored in `~/system/cron.json`
- Kernel can create/remove cron jobs via IPC `cron` tool
- Cron service fires at correct intervals
- Heartbeat runner picks up cron events and invokes kernel
- Kernel sends reminder to the appropriate channel

### US9b: "The OS sends me a morning summary"

Every morning at 8am, the OS checks my calendar (if connected), reviews pending tasks, checks module health, and sends me a summary via Telegram: "Good morning. 3 modules running. 2 reminders today. Expense tracker has 5 new entries since yesterday."

**Acceptance criteria:**
- Heartbeat runs on configurable interval (default 30min)
- `~/agents/heartbeat.md` defines proactive tasks
- Active hours prevent night-time disturbance (e.g., 8am-10pm)
- Heartbeat responses route to configured channel
- If no channel configured, logged to activity feed

### US9c: "The OS notices patterns and suggests automation"

After I ask "what's the weather?" three days in a row, the OS adds a note to its long-term memory: "User checks weather daily. Consider offering a morning weather summary." Next time the heartbeat runs, it offers to set up an automated weather check.

**Acceptance criteria:**
- Kernel writes observations to `~/agents/memory/long-term.md`
- Heartbeat prompt includes recent memory observations
- Kernel can suggest new cron jobs based on patterns
- This is emergent behavior (kernel decides based on context, not hardcoded rules)

### US10: "I deploy Matrix OS on a cloud server and access it from anywhere"

I spin up a $5/month VPS. I run the setup script. I configure my Telegram token and API key. The OS boots, connects to Telegram, starts the heartbeat. I access the web desktop from my browser at `https://my-matrixos.example.com`. I message it from Telegram on my phone. Same OS, same state, always on.

**Acceptance criteria:**
- Single Docker container runs gateway + shell
- Volume mount for `~/matrixos/` data persistence
- `MATRIX_AUTH_TOKEN` protects web shell on public internet
- Channels connect outbound (no inbound ports needed beyond web)
- systemd service file for bare-metal deployment
- Setup script for quick cloud VM provisioning

---

## 3. SOUL Identity System

### What SOUL Is

SOUL is a file at `~/system/soul.md` that defines who the OS is. It is the personality layer -- not the capabilities (those are skills) or the state (that's `state.md`), but the identity.

Inspired by Nanobot's `SOUL.md` (workspace/SOUL.md) and OpenClaw's agent identity system.

### Default SOUL

```markdown
# Matrix OS

## Identity
I am Matrix OS -- a personal operating system and AI assistant. I run on your machine (or your server), I generate software from conversation, and I'm always here when you need me.

## Personality
- Direct and clear. I don't waste words.
- Curious about your needs. I ask when something is ambiguous.
- Proactive. I suggest improvements and notice patterns.
- Honest about limitations. I say when I can't do something.

## Values
- Your data is yours. Everything is a file you own.
- Privacy first. I don't phone home.
- Transparency. I explain what I'm doing and why.
- Reliability. I'd rather do less than promise more than I can deliver.

## Communication Style
- Concise responses for simple questions
- Detailed explanations when building something complex
- I adapt to the channel: shorter for messaging, richer for web
- I use the user's language and tone
```

### How SOUL Is Loaded

```
buildSystemPrompt():
  1. Core identity (registers, ~2K tokens)    <-- always present
  2. SOUL content (~300-500 tokens)            <-- always present (L0)
  3. L1 cache (state, modules, processes)
  4. Skills TOC
  5. Knowledge TOC
  6. User profile + memory
```

SOUL is in L0 -- it is never evicted, never compressed, always shapes every response. This is the cheapest way to give the OS consistent personality across all interactions and channels.

### Editing SOUL

The user can edit `soul.md` directly (it's a file) or ask the OS to change it:

- "Be more formal" -> kernel edits `soul.md` to adjust communication style
- "Your name is Jarvis" -> kernel edits the identity section
- "Don't be so chatty" -> kernel adjusts to more concise style

This is self-evolution applied to personality, not code.

---

## 4. Skills System

### What Skills Are

Skills are markdown files that teach the kernel new behaviors. They are NOT tools (tools are code that executes). Skills are prompt injections that expand what the kernel knows how to do.

Inspired by Nanobot's `skills/` (YAML frontmatter + markdown body) and OpenClaw's skills system.

### Skill Format

```markdown
---
name: weather
description: Look up current weather for any location
triggers:
  - weather
  - forecast
  - temperature
---

# Weather Lookup

When the user asks about weather:

1. Use WebSearch to find current weather for the requested location
2. Extract: temperature, conditions, humidity, wind
3. Format response based on channel:
   - Web shell: include icon emoji and detailed forecast
   - Telegram/WhatsApp: concise one-line summary
   - If no location specified, use user's location from user-profile.md

## Example Responses

**Web shell**: "Stockholm: 3C, overcast, 85% humidity, wind 12 km/h NW. Tomorrow: slight warming to 5C."
**Telegram**: "Stockholm: 3C, overcast. Tomorrow 5C."
```

### How Skills Load

1. On boot, kernel scans `~/agents/skills/*.md`
2. Parses frontmatter: `name`, `description`, `triggers`
3. Builds skills TOC (names + descriptions, ~5 tokens per skill)
4. TOC is injected into system prompt
5. When a user message matches a trigger keyword, kernel loads the full skill body via `load_skill` IPC tool
6. Skill body is injected into the current turn context
7. Kernel follows the skill's instructions

### Built-in Skills

| Skill | Description | Trigger Keywords |
|-------|------------|-----------------|
| `summarize.md` | Summarize text, articles, conversations | summarize, tldr, summary |
| `weather.md` | Weather lookup via web search | weather, forecast, temperature |
| `reminder.md` | Create cron reminders via IPC | remind, reminder, alarm, schedule |
| `skill-creator.md` | Meta-skill: create new skills | learn, new skill, teach |

### Self-Expanding Skills

The `skill-creator.md` skill teaches the kernel how to create new skills. When a user says "learn how to check my GitHub stars", the kernel:

1. Loads `skill-creator.md`
2. Follows its instructions to create `~/agents/skills/github-stars.md`
3. The new skill is available on the next interaction (hot reload)

This is the "OS creates new capabilities by writing files" principle applied to skills.

---

## 5. Channel Architecture

### Design Principles

1. **Channels are shells** (Principle III) -- they are renderers, not logic. The kernel doesn't know or care which channel a message came from.
2. **Everything is a file** (Principle I) -- channel config in `config.json`, channel state in `channels.json`, auth in dedicated dirs.
3. **Simplicity** (Principle V) -- each adapter is a single file, ~100-200 lines. No shared base class hierarchy. Just an interface.

### The ChannelAdapter Interface

```typescript
interface ChannelAdapter {
  readonly id: ChannelId;

  // Lifecycle
  start(config: ChannelConfig): Promise<void>;
  stop(): Promise<void>;

  // Outbound: send a reply to the channel
  send(reply: ChannelReply): Promise<void>;

  // Inbound: set by ChannelManager, called when a message arrives
  onMessage: (msg: ChannelMessage) => void;
}

type ChannelId = "telegram" | "whatsapp" | "discord" | "slack";

type ChannelMessage = {
  source: ChannelId;
  senderId: string;
  senderName?: string;
  text: string;
  chatId: string;           // channel-specific chat/conversation ID
  replyToId?: string;       // for threaded replies
};

type ChannelReply = {
  chatId: string;
  text: string;
  replyToId?: string;
};

type ChannelConfig = {
  enabled: boolean;
  token?: string;            // Telegram, Discord
  botToken?: string;         // Slack
  appToken?: string;         // Slack (Socket Mode)
  authDir?: string;          // WhatsApp
  allowFrom?: string[];      // user ID whitelist (empty = allow all)
};
```

### Message Flow

```
Telegram Bot API  -->  TelegramAdapter.onMessage()
                            |
                            v
                       ChannelManager
                            |
                            v
                    Dispatcher.dispatch({
                      text: "What modules are running?",
                      source: "telegram",
                      senderId: "123456",
                      chatId: "123456",
                      sessionKey: "telegram:123456"
                    })
                            |
                            v
                    Kernel (Agent SDK query)
                      - SOUL loaded
                      - Channel context injected:
                        "[Channel: telegram] [User: Hamed]"
                      - channel-routing.md knowledge loaded
                            |
                            v
                    Response: "3 modules running..."
                            |
                            v
                    formatForChannel("telegram", response)
                            |
                            v
                    TelegramAdapter.send({
                      chatId: "123456",
                      text: "3 modules running..."
                    })
```

### Channel-Specific Formatting

The kernel produces markdown. Each channel needs different formatting:

| Channel | Input Format | Output Format | Notes |
|---------|-------------|--------------|-------|
| Web Shell | Markdown | Markdown (rendered in ChatPanel) | Passthrough |
| Telegram | Plain text | MarkdownV2 (escaped special chars) | `*bold*` -> `\*bold\*` escape rules |
| WhatsApp | Plain text | Plain text (basic formatting) | No rich markdown support |
| Discord | Markdown | Discord markdown (mostly passthrough) | Code blocks, bold, italic work |
| Slack | Plain text | mrkdwn (`*bold*` not `**bold**`) | Different bold syntax |

`formatForChannel()` handles this conversion. The kernel writes standard markdown; the adapter formats it.

### Session Management

Each channel + sender combination maps to a conversation:

- Session key format: `{channelId}:{senderId}` (e.g., `telegram:123456`)
- Conversations stored at `~/system/conversations/{sessionKey}.json`
- Web shell uses `web:{browserSessionId}`
- All conversations visible in web shell's conversation switcher

This means you can start a conversation on Telegram, then continue it on the web desktop -- the context is preserved.

### Channel Config

```json
// ~/system/config.json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "123456:ABC-DEF...",
      "allowFrom": ["your_telegram_user_id"]
    },
    "whatsapp": {
      "enabled": false,
      "authDir": "system/whatsapp-auth",
      "allowFrom": []
    },
    "discord": {
      "enabled": false,
      "token": "",
      "allowFrom": []
    },
    "slack": {
      "enabled": false,
      "botToken": "",
      "appToken": "",
      "allowFrom": []
    }
  }
}
```

### Channel Priority and Implementation Order

1. **Telegram** (first) -- simplest. HTTP long-polling via `node-telegram-bot-api`. No persistent connection management. 1 npm dep. ~100 lines.
2. **WhatsApp** (second) -- uses Baileys (unofficial but widely used). QR code pairing. Auth state persistence. ~200 lines + bridge.
3. **Discord** (third) -- official SDK (`discord.js`). Gateway Intents for message content. ~150 lines.
4. **Slack** (fourth) -- official SDK (`@slack/bolt`). Socket Mode (no public URL). ~150 lines.

### Knowledge File: channel-routing.md

Injected into kernel context when a message comes from a channel:

```markdown
# Channel Routing

You are responding to a message from a messaging channel.

## Formatting Rules
- Keep responses concise (messaging is conversational, not documentation)
- Use plain language, minimal formatting
- For code: use inline code for short snippets, code blocks for longer ones
- Don't use headers (##) in channel responses -- they look weird in messages
- Emoji: use sparingly and only when natural

## Channel Context
The [Channel: X] prefix tells you which channel this came from.
Adjust your response length and style:
- Telegram: medium-length, MarkdownV2 formatting available
- WhatsApp: shorter, plain text preferred
- Discord: can use rich formatting, code blocks, embeds
- Slack: mrkdwn syntax, can use blocks

## Capabilities
From any channel, the user can:
- Ask questions (you have full web search + file system access)
- Request app generation ("build me X")
- Check OS status ("what modules are running?")
- Create reminders ("remind me to X in Y")
- Manage the OS ("change the theme", "restart the notes app")

You have the same full capabilities regardless of channel.
```

---

## 6. Cron System

### What Cron Does

Cron is a scheduler that fires events at configured times. Events are either:

1. **Reminders**: messages sent directly to the user via a channel
2. **Tasks**: prompts sent to the kernel for execution (kernel responds and may send result to user)

Inspired by OpenClaw's `CronService` and Nanobot's `cron` tool.

### Cron Job Format

```json
// ~/system/cron.json
[
  {
    "id": "cron_abc123",
    "name": "water-reminder",
    "message": "Time to drink water!",
    "schedule": {
      "type": "interval",
      "intervalMs": 7200000
    },
    "target": {
      "channel": "telegram",
      "chatId": "123456"
    },
    "createdAt": "2026-02-12T10:00:00Z"
  },
  {
    "id": "cron_def456",
    "name": "morning-summary",
    "message": "Generate a morning summary of active modules, pending tasks, and recent activity. Send it to the user.",
    "schedule": {
      "type": "cron",
      "cron": "0 8 * * *"
    },
    "target": {
      "channel": "telegram",
      "chatId": "123456"
    },
    "createdAt": "2026-02-12T10:05:00Z"
  },
  {
    "id": "cron_ghi789",
    "name": "meeting-reminder",
    "message": "Your meeting starts in 15 minutes!",
    "schedule": {
      "type": "once",
      "at": "2026-02-12T14:45:00Z"
    },
    "target": {
      "channel": "whatsapp",
      "chatId": "46701234567@s.whatsapp.net"
    },
    "createdAt": "2026-02-12T10:10:00Z"
  }
]
```

### Schedule Types

| Type | Field | Description | Example |
|------|-------|-------------|---------|
| `cron` | `cron` | Standard cron expression (5-field) | `0 8 * * *` = daily at 8am |
| `interval` | `intervalMs` | Repeat every N milliseconds | `7200000` = every 2 hours |
| `once` | `at` | Fire once at ISO timestamp | `2026-02-12T14:45:00Z` |

### IPC Tool: `cron`

The kernel creates cron jobs via an IPC MCP tool:

```typescript
cron({
  action: "add",
  name: "water-reminder",
  message: "Time to drink water!",
  schedule: { type: "interval", intervalMs: 7200000 },
  target: { channel: "telegram", chatId: "123456" }
})
// Returns: { id: "cron_abc123", created: true }

cron({ action: "list" })
// Returns: [{ id, name, message, schedule, target, createdAt }]

cron({ action: "remove", jobId: "cron_abc123" })
// Returns: { removed: true }
```

### How Cron Fires

1. `CronService` runs in the gateway process
2. On startup, loads `~/system/cron.json` and schedules all active jobs
3. When a job fires:
   - If `target.channel` is set: send message directly to channel adapter
   - If message looks like a task (contains verbs like "generate", "check", "review"): invoke kernel via dispatcher, route response to target channel
   - If no target: invoke kernel via heartbeat, log response to activity feed
4. On mutation (add/remove): save to `cron.json` immediately (atomic write)

---

## 7. Heartbeat System

### What Heartbeat Does

Heartbeat is a periodic kernel invocation that makes the OS proactive. Instead of waiting for the user to ask something, the heartbeat wakes the kernel on a schedule and says: "check your tasks, check your reminders, check the system, and act if needed."

Inspired by OpenClaw's `heartbeat-runner.ts` (1K lines) and Nanobot's `HEARTBEAT.md` pattern.

### How Heartbeat Works

```
Every N minutes (default: 30):
  1. Check active hours (skip if outside configured hours)
  2. Read ~/agents/heartbeat.md (task list)
  3. Check CronService for pending events
  4. Build heartbeat prompt
  5. Invoke kernel via dispatcher with source: "heartbeat"
  6. Kernel reads tasks, executes what's needed
  7. If kernel generates a response targeted at a channel, route it
  8. If nothing to do, kernel responds "HEARTBEAT_OK" (no action)
```

### Heartbeat Prompt

```markdown
You are running a periodic heartbeat check. Current time: {ISO timestamp}.
Timezone: {user timezone}.

## Your Tasks (from heartbeat.md)
{content of ~/agents/heartbeat.md}

## Pending Events
{cron events that fired since last heartbeat}

## Instructions
- Review each task. Execute any that are due.
- If a cron event needs to be relayed to the user, send it via the appropriate channel.
- If you have observations about user patterns, write them to ~/agents/memory/long-term.md.
- If nothing needs action, respond with HEARTBEAT_OK.
- Keep responses concise -- this is a background task, not a conversation.
```

### Active Hours

Heartbeat respects active hours to avoid disturbing the user at night:

```json
// ~/system/config.json
{
  "heartbeat": {
    "enabled": true,
    "everyMinutes": 30,
    "activeHours": {
      "start": "08:00",
      "end": "22:00",
      "timezone": "Europe/Stockholm"
    }
  }
}
```

Outside active hours, heartbeat fires for health checks only (module pings), not for proactive messaging.

### Default heartbeat.md

```markdown
# Heartbeat Tasks

Tasks checked every heartbeat cycle. Edit this file to add/remove tasks.
The kernel can also modify this file based on your instructions.

## Health Checks
- [ ] Ping all running web modules (check /health endpoint)
- [ ] If a module fails 3 consecutive checks, spawn healer

## Pending Reminders
(Managed by cron system -- do not edit manually)

## Observations
(Write patterns you notice here. Suggest automation when appropriate.)
```

---

## 8. Cloud Deployment

### Architecture (Cloud)

```
Cloud VM (e.g., Hetzner, DigitalOcean, Fly.io)
  |
  +-- Docker Container (or systemd service)
       |
       +-- Gateway (Hono, port 4000)
       |    |-- Web Shell (Next.js, served via reverse proxy)
       |    |-- Channel Adapters (outbound connections)
       |    |    |-- Telegram (HTTP polling)
       |    |    |-- WhatsApp (WebSocket to WA servers)
       |    |    |-- Discord (WebSocket to Discord)
       |    |    |-- Slack (Socket Mode WebSocket)
       |    |-- CronService
       |    |-- HeartbeatRunner
       |    |-- Dispatcher -> Kernel (Agent SDK)
       |
       +-- Volume: ~/matrixos/ (persistent data)
       |
       +-- Environment:
            ANTHROPIC_API_KEY=sk-ant-...
            MATRIX_AUTH_TOKEN=random-secret
            PORT=4000
```

### Key Decisions

1. **Single container**: gateway + shell in one process. Simplicity over microservices.
2. **Outbound-only channels**: Telegram polls, WhatsApp/Discord/Slack use WebSocket to their servers. No inbound ports needed beyond the web shell.
3. **Reverse proxy**: Caddy or nginx terminates HTTPS, forwards to port 4000. Not part of Matrix OS (infra concern).
4. **Auth token**: `MATRIX_AUTH_TOKEN` env var. If set, all HTTP/WebSocket requests must include `Authorization: Bearer <token>`. Channel adapters are exempt (they connect outbound).
5. **Data persistence**: Docker volume mount at `~/matrixos/`. All state is files. Backup = copy the volume.

### Dockerfile

```dockerfile
FROM node:22-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ packages/
COPY shell/ shell/
COPY home/ home/
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/home ./home
COPY --from=build /app/node_modules ./node_modules
ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000
CMD ["node", "dist/gateway/index.js"]
```

### systemd Service

```ini
[Unit]
Description=Matrix OS
After=network.target

[Service]
Type=simple
User=matrixos
WorkingDirectory=/opt/matrixos
EnvironmentFile=/etc/matrixos/env
ExecStart=/usr/bin/node dist/gateway/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Setup Script (scripts/setup-server.sh)

```bash
#!/bin/bash
# Quick setup for a fresh cloud VM
# Usage: curl -sSL https://raw.githubusercontent.com/.../setup-server.sh | bash

set -e

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install pnpm
corepack enable
corepack prepare pnpm@latest --activate

# Clone and build
git clone https://github.com/... /opt/matrixos
cd /opt/matrixos
pnpm install --frozen-lockfile
pnpm build

# Create env file
sudo mkdir -p /etc/matrixos
echo "ANTHROPIC_API_KEY=" | sudo tee /etc/matrixos/env
echo "MATRIX_AUTH_TOKEN=$(openssl rand -hex 32)" | sudo tee -a /etc/matrixos/env
echo "MATRIX_HOME=/home/matrixos/data" | sudo tee -a /etc/matrixos/env

# Install systemd service
sudo cp scripts/matrixos.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable matrixos
sudo systemctl start matrixos

echo "Matrix OS is running. Configure your API key in /etc/matrixos/env"
echo "Then: sudo systemctl restart matrixos"
```

---

## 9. How It All Fits Together

### Scenario: A Day with Matrix OS

**8:00 AM** -- Heartbeat fires. Reads `heartbeat.md`. Cron has a "morning summary" job due. Kernel generates: "Good morning. 3 modules running (notes, expense-tracker, dashboard). 2 reminders today. Weather in Stockholm: 2C, cloudy." Sends to Telegram.

**8:15 AM** -- You read the Telegram message on your phone. Reply: "Add a workout tracker to my modules." Kernel receives via Telegram adapter, spawns builder sub-agent, starts generating the module.

**8:20 AM** -- Builder finishes. Kernel sends to Telegram: "Workout tracker is live. Open your desktop to see it, or tell me what to track."

**10:00 AM** -- You open the web desktop at `https://my-matrixos.example.com`. See the new workout tracker in a window, alongside your other modules. You click inside it, enter today's workout via the OS bridge.

**12:00 PM** -- Cron fires "water reminder". Heartbeat sends to Telegram: "Time to drink water!"

**2:00 PM** -- You're in a Slack workspace. You DM the Matrix OS bot: "How many workouts have I logged this week?" Kernel reads `~/data/workout-tracker/`, responds in Slack: "3 workouts this week. Monday: running 5k. Wednesday: weights. Today: yoga."

**6:00 PM** -- You open the web desktop. Ask: "Show me a dashboard of my workout history." Kernel generates a chart app using the data from `~/data/workout-tracker/`. Dashboard appears as a new window.

**10:00 PM** -- Active hours end. Heartbeat stops sending proactive messages. Health checks continue silently.

### The Architecture That Makes This Work

```
                SOUL (identity)
                     |
     Skills ----  Kernel (Agent SDK)  ---- Knowledge files
                     |
              +------+------+
              |      |      |
          Dispatcher IPC   Hooks
              |
    +---------+---------+---------+---------+
    |         |         |         |         |
  Web WS   Telegram  WhatsApp  Discord   Slack
  (shell)  (adapter) (adapter) (adapter) (adapter)
    |         |         |         |         |
    v         v         v         v         v
  Browser   Phone     Phone   Desktop   Desktop
              |
              +--- CronService (scheduled triggers)
              +--- HeartbeatRunner (periodic wakeups)
              |
              v
         File System (~/matrixos/)
         - system/soul.md
         - system/config.json
         - system/cron.json
         - agents/skills/*.md
         - agents/heartbeat.md
         - agents/memory/long-term.md
         - system/conversations/*.json
         - Everything is a file.
```

---

## 10. What Does NOT Change

These core systems remain unchanged:

- **Kernel** (`spawnKernel`, `query()` with `resume`) -- channels just route through the existing dispatcher
- **IPC MCP server** -- gains one new tool (`cron`), otherwise unchanged
- **Hooks** -- all existing hooks work as-is
- **ConversationStore** -- works with any session key format
- **File watcher** -- already watches `~/matrixos/`, channels benefit from it
- **Web shell** -- fully functional as-is, channels are additive
- **Self-healing / self-evolution** -- independent of channels

The new systems (SOUL, skills, channels, cron, heartbeat, cloud) are **additive layers**, not modifications to the core. If you remove all of them, you still have a working visual OS.
