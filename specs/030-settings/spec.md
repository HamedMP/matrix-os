# 030: Settings Dashboard

## Problem

Matrix OS configuration is scattered across file editing (`~/system/config.json`, `~/system/soul.md`, `~/agents/skills/*.md`) and API endpoints. There's no unified UI for managing the agent, channels, models, skills, security, cron jobs, or system health. Finna Cloud provides a full management dashboard for Moltbot instances with 20+ pages. Matrix OS needs similar settings capabilities built into the shell, not as a separate app.

## Solution

A Settings panel integrated into the existing shell at `/settings` (or accessible via Cmd+, / Settings icon in dock). Uses the same design system (terracotta/lavender, shadcn/ui). Reads/writes configuration through gateway API endpoints. Organized into sections matching the system's architecture: Agent, Channels, Skills, Security, Cron, Plugins, System.

## Design

### Architecture

Settings lives inside the shell (`shell/src/app/settings/`). It communicates with the gateway via existing + new API endpoints. All config changes ultimately write to `~/system/config.json` or other files in the home directory (Everything Is a File).

```
Shell (Next.js)
  /settings/
    agent/         # SOUL, identity, prompt files
    channels/      # Channel adapter configuration
    skills/        # Skills enable/disable/browse
    security/      # Security audit, exec rules, sandbox
    cron/          # Cron job management
    plugins/       # Plugin management
    system/        # System info, logs, health, backups
```

### Navigation

Settings uses a sidebar navigation (left sidebar with section links, content on right). On mobile: full-screen with back button per section.

```
+------------------+----------------------------------------+
| Settings         |                                        |
|                  |  [Section Content]                     |
| > Agent          |                                        |
|   Channels       |                                        |
|   Skills         |                                        |
|   Security       |                                        |
|   Cron           |                                        |
|   Plugins        |                                        |
|   System         |                                        |
+------------------+----------------------------------------+
```

### Sections

#### Agent Settings
- **SOUL editor**: Markdown editor for `~/system/soul.md` (agent personality, tone, boundaries)
- **Identity**: Display name, handle, AI profile (from identity system)
- **Agent files**: Tabbed editor for custom agent prompts (`~/agents/custom/*.md`)
- **Model selection**: Choose primary AI model (for future multi-provider support)
- Read via `GET /files/system/soul.md`, write via `PUT /files/system/soul.md` (existing file API)

#### Channels
- **Channel cards**: One card per supported channel (Telegram, Discord, Slack, WhatsApp, etc.)
- **Status badge**: connected (green), configured (yellow), error (red), not configured (gray)
- **Setup flow**: Expandable config form per channel (bot token, API keys, allowlists)
- **Test connection**: Button to verify channel connectivity
- Read via `GET /api/channels/status`, write via config.json API

#### Skills
- **Skills grid**: All installed skills as cards with name, description, status
- **Status**: Ready / Needs API key / Disabled
- **Enable/disable toggle**: Per-skill
- **Skill detail**: Expand to see full skill content (markdown preview)
- **Add skill**: Upload .md file or paste content
- Read from `GET /files/agents/skills/` (directory listing), toggle via config

#### Security
- **Audit dashboard**: Run `GET /api/security/audit`, display findings with severity badges
- **Remediation**: Each finding shows fix instructions
- **Exec rules**: List of shell command approval rules (allow/deny/ask patterns)
- **Sandbox config**: Enable/disable, workspace access mode
- **Security headers**: CORS, CSP configuration
- Requires 025-security audit endpoint

#### Cron
- **Job list**: All cron jobs with name, schedule, status, next run
- **Create job**: Form with name, schedule (cron expression builder), message, delivery target
- **Enable/disable**: Toggle per job
- **Run history**: Last N runs with status (success/error)
- **Templates**: Pre-built cron job templates
- Read/write via `GET/POST /api/cron` (existing)

#### Plugins
- **Installed plugins**: List with name, version, origin, status
- **Capabilities**: What each plugin contributes (tools, hooks, channels)
- **Install**: URL or local path input
- **Uninstall**: Remove with confirmation
- **Plugin config**: Per-plugin config editor
- Requires 029-plugins API endpoints

#### System
- **Info**: OS version, gateway status, uptime, home directory path
- **Health**: Component health checks (gateway, channels, kernel)
- **Logs**: Streaming log viewer (reuse existing log viewer pattern)
- **Backup**: Git snapshot status, manual backup trigger
- **Theme**: Light/dark/system preference
- **About**: Matrix OS logo, version, links

### New API Endpoints Needed

```
GET  /api/settings/agent          # Agent config summary
PUT  /api/settings/agent          # Update agent config
GET  /api/settings/channels       # Channel configs (merged with status)
PUT  /api/settings/channels/:id   # Update channel config
GET  /api/settings/skills         # Skills list with status
PUT  /api/settings/skills/:id     # Enable/disable skill
GET  /api/settings/security       # Security config
PUT  /api/settings/security       # Update security config
GET  /api/settings/system         # System info
POST /api/settings/backup         # Trigger backup
```

Most reads can use existing `/files/*` and `/api/*` endpoints. New endpoints only where aggregation is needed.

## Dependencies

- Shell (Phase 4) -- complete
- Gateway API -- complete
- 025-security (for audit dashboard) -- can ship settings before this, just hide security section
- 029-plugins (for plugins section) -- can ship settings before this, just hide plugins section

## File Locations

```
shell/src/app/settings/
  layout.tsx                # Settings layout with sidebar navigation
  page.tsx                  # Settings overview / redirect to agent
  agent/page.tsx            # Agent settings
  channels/page.tsx         # Channel configuration
  skills/page.tsx           # Skills management
  security/page.tsx         # Security dashboard
  cron/page.tsx             # Cron job management
  plugins/page.tsx          # Plugin management
  system/page.tsx           # System info + health
shell/src/components/settings/
  SettingsSidebar.tsx        # Left sidebar navigation
  SoulEditor.tsx             # Markdown editor for SOUL
  ChannelCard.tsx            # Channel status + config card
  SkillCard.tsx              # Skill card with toggle
  AuditFinding.tsx           # Security finding with severity badge
  CronJobForm.tsx            # Cron job create/edit form
  PluginCard.tsx             # Plugin info card
  LogViewer.tsx              # Streaming log viewer
packages/gateway/src/
  routes/settings.ts         # New settings API routes
```
