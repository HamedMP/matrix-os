# 009: Web 4 Platform Vision

## The Big Picture

Matrix OS evolves from a single-user local OS into **Web 4** -- a platform that bridges offline/local devices and online services. Every person gets a digital identity (handle) paired with an AI identity. Users interact with their OS from any device, any channel. AIs interact with each other. The platform enables app sharing, monetization, and a new paradigm of human-AI collaboration.

**Terminal > Operating System > GUI > Multi-channel, AI-powered OS for everything in life, work, and universe.**

## Core Concepts

### 1. Identity System (Handles)

Each user gets two paired handles:
- `@hamed` -- the human identity
- `@hamed_ai` -- the AI identity

Handles are globally unique. Both are first-class entities that can send/receive messages, have profiles, and interact with the world.

**Human profile** (`~/system/profile.md`):
- Display name, avatar, bio
- Preferred channels, timezone, language
- Public/private visibility settings

**AI profile** (`~/system/ai-profile.md`):
- Personality summary (derived from SOUL)
- Available skills (public subset)
- Tools and capabilities
- Recent public activity (like X/Twitter posts)
- Owner handle

### 2. Multi-User Platform

Users sign up, get a handle, get a fresh Matrix OS instance:
- Central auth service manages handles + credentials
- Each user gets isolated `~/matrixos/` home directory
- Users customize their OS via conversation ("make it dark", "I prefer bullet points")
- Instances run as containers or isolated processes on shared infrastructure

### 3. Inter-Profile Messaging

```
@hamed        -->  @alice         (human to human)
@hamed        -->  @alice_ai      (human to someone's AI)
@hamed_ai     -->  @alice_ai      (AI to AI collaboration)
@hamed_ai     -->  @hamed         (AI proactively messaging its owner)
```

Security model -- **call center approach**:
- External requests get **sandboxed context** -- the receiving AI answers from a curated public profile, NOT from the owner's private files
- Like a call center: the agent represents the owner but doesn't have access to their filing cabinet during the call
- Owner can configure what's public vs private
- Internal (owner) requests get full context as usual
- Rate limiting per external sender

### 4. App Dev Kit & Marketplace

Matrix OS apps are files. This makes distribution trivial:

**App Dev Kit (SDK)**:
- Documentation for building Matrix OS apps
- App template generator ("create a new Matrix OS app")
- `window.MatrixOS` bridge API reference
- Module manifest (`module.json`) standard
- Theme integration guide (CSS custom properties)
- Testing utilities (mock MatrixOS bridge)

**Marketplace**:
- Apps are published as files/directories (git repos)
- Browse, search, install (`matrixos install @creator/app-name`)
- Rating system, usage stats
- Monetization: free, one-time purchase, subscription
- Revenue split model (platform takes %)
- Apps run sandboxed -- they can only access `~/data/{appName}/`

### 5. Multi-Device Access

Matrix OS runs in the cloud, accessible from everywhere:

**Web shell** (existing):
- Desktop browser: full desktop experience
- Mobile browser: responsive layout (dock becomes bottom tab bar, windows become full-screen cards)

**Native mobile app** (future):
- Expo/React Native wrapper
- Push notifications for reminders/heartbeat
- Quick-reply from notification shade
- Camera/mic access for rich input

**Device bridging**:
- Local machine <-> cloud instance communication
- Run Matrix OS locally AND in the cloud
- Local instance handles compute-heavy tasks, cloud handles always-on messaging
- Secure tunnel (SSH / WireGuard) between devices

### 6. Git Sync

Home directory is already a git repo (from Phase 2 first-boot). Extend this:

**Local <-> Cloud sync**:
- `matrixos sync` pushes/pulls changes between local and cloud instance
- Automatic sync on significant changes (configurable)
- Conflict resolution: kernel-assisted merge

**Remote repos**:
- Add arbitrary git remotes: `matrixos remote add github git@github.com:user/matrixos-data.git`
- Backup to GitHub/GitLab
- Share specific directories with collaborators

**Implementation**:
- chokidar watches for changes -> debounced git commit -> git push
- Pull on boot / periodic pull for remote changes
- `.gitignore` for large/sensitive files

### 7. AI Social Profile

The AI is a public entity that can interact with the world:

**Activity feed as public posts**:
- AI publishes notable activities: "Built a new expense tracker for @hamed"
- Followers can see what AIs are building/doing
- Like X/Twitter but for AI agents

**AI capabilities profile**:
- Lists skills, tools, recent work
- Other users can "ask" your AI things (via inter-profile messaging)
- Reputation score based on uptime, response quality, activity

### 8. Safe Mode Agent

A minimal recovery agent when the main kernel is broken:

**Trigger**:
- Main kernel crashes 3+ times in succession
- User explicitly requests safe mode
- Watchdog detects unrecoverable state

**Capabilities** (deliberately limited):
- Read, Write, Edit, Bash (no agent spawning, no MCP)
- Can reset config files to defaults
- Can restore from last known good git commit
- Can reinstall dependencies (`pnpm install`)
- Can regenerate `state.md` from file system scan
- Reports what it did and exits back to normal mode

**Like Windows Safe Mode** but AI-powered -- it understands what's wrong and fixes it.

### 9. Observability & Logging

Log all kernel interactions for debugging and audit:

**Structured logs** (`~/system/logs/`):
```json
{
  "timestamp": "2026-02-13T10:00:00Z",
  "source": "web",
  "sessionId": "sess_abc",
  "prompt": "Build me a notes app",
  "tools_used": ["Write", "Bash", "Read"],
  "tokens_in": 5000,
  "tokens_out": 12000,
  "cost_usd": 0.45,
  "duration_ms": 8500,
  "result": "success"
}
```

**Debug mode**: verbose logging with full context (prompt, response, tool calls)
**Log viewer**: shell component for browsing/searching logs
**Export**: CSV/JSON export for external analysis
**Cost tracking**: running total of AI spend

### 10. Distribution (Shell / Linux Distro)

Package Matrix OS as a standalone computing layer:

**As a shell**:
- `matrixos` command replaces default shell for non-technical users
- Natural language commands instead of bash syntax
- Falls through to bash for unrecognized commands

**As a distribution**:
- Installer script that provisions a fresh server
- Custom motd/login that boots into Matrix OS
- `.deb`/`.rpm` packages for Linux servers
- Snap/Flatpak for desktop Linux

## Priority for Hackathon

**P0 (must have):**
- Basic identity (handle in `soul.md`, respond to "who are you?")
- Interaction logging (append structured logs)
- Safe mode agent (basic recovery)

**P1 (demo-worthy):**
- Handle system (username + username_ai naming)
- Git sync (local <-> cloud)
- Mobile-responsive web shell
- Cost tracking dashboard

**P2 (post-hackathon):**
- Multi-user signup + auth
- Inter-profile messaging (sandboxed)
- App marketplace
- Native mobile app
- AI social profiles
- Linux distribution packaging

## Dependencies

- 005-soul-skills (SOUL is the foundation for identity)
- 006-channels (messaging infrastructure for inter-profile comms)
- 008-cloud (cloud deployment for always-on platform)
