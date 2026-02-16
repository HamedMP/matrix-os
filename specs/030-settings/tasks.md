# Tasks: Settings Dashboard

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T970-T999

## User Stories

- **US52**: "I can configure my agent's personality and behavior from a settings UI"
- **US53**: "I can set up and manage messaging channels without editing JSON"
- **US54**: "I can enable/disable skills and see what's available"
- **US55**: "I can manage cron jobs and scheduled tasks visually"
- **US56**: "I can see my system's security posture and fix issues"
- **US57**: "I can manage plugins, check system health, and view logs"

---

## Phase A: Settings Shell (T970-T973)

### T970 [US52] Settings layout + routing
- [ ] Create `shell/src/app/settings/layout.tsx` -- sidebar + content layout
- [ ] Sidebar navigation: Agent, Channels, Skills, Security, Cron, Plugins, System
- [ ] Active section highlighted (terracotta text/border)
- [ ] Content area scrollable, sidebar fixed
- [ ] Create `shell/src/app/settings/page.tsx` -- redirect to /settings/agent
- **Output**: Settings page shell with navigation

### T971 [US52] Settings dock integration
- [ ] Add Settings icon to dock (Lucide `Settings` icon)
- [ ] Click opens /settings as a window (or full-screen route)
- [ ] Cmd+, keyboard shortcut opens settings
- [ ] Add to Cmd+K command palette: "Open Settings"
- **Output**: Settings accessible from dock and keyboard

### T972 [US52] Settings sidebar component
- [ ] Create `shell/src/components/settings/SettingsSidebar.tsx`
- [ ] Section links with icons (Lucide):
  - User (agent), MessageSquare (channels), Sparkles (skills)
  - Shield (security), Clock (cron), Puzzle (plugins), Monitor (system)
- [ ] Active state: terracotta text, left border accent
- [ ] Collapse to icons-only on narrow screens
- **Output**: Sidebar navigation component

### T973 [US52] Mobile responsive settings
- [ ] Mobile: hide sidebar, show section list as cards on /settings
- [ ] Tap section card -> navigate to section page
- [ ] Back button to return to section list
- [ ] Full-width content on mobile
- **Output**: Settings works on mobile

---

## Phase B: Agent + Channels (T974-T979)

### Tests (TDD -- write FIRST)

- [ ] T974a Write `shell/src/__tests__/SoulEditor.test.tsx`:
  - Loads soul.md content from API
  - Renders markdown preview
  - Edit mode shows textarea
  - Save sends PUT to /files/system/soul.md
  - Dirty state tracked (unsaved changes warning)

### T974 [US52] Agent settings page
- [ ] Create `shell/src/app/settings/agent/page.tsx`
- [ ] Sections:
  - [ ] **Identity**: Display name, handle (@user:matrix-os.com), AI handle
  - [ ] **SOUL**: Markdown editor for ~/system/soul.md
  - [ ] **Agent files**: Tabbed view for ~/agents/custom/*.md (builder, researcher, healer, etc.)
- [ ] Read via `GET /files/system/soul.md` (existing API)
- [ ] Write via PUT to same endpoint
- **Output**: Agent personality configuration UI

### T975 [US52] Markdown editor component
- [ ] Create `shell/src/components/settings/MarkdownEditor.tsx`
- [ ] Two modes: edit (textarea) / preview (rendered markdown)
- [ ] Toggle button between modes
- [ ] Auto-save on blur (with debounce) or explicit Save button
- [ ] Unsaved changes indicator (dot badge)
- [ ] Monospace font (JetBrains Mono) in edit mode
- [ ] Reusable across SOUL, agent files, skills
- **Output**: Reusable markdown file editor

### T976 [US53] Channel cards
- [ ] Create `shell/src/app/settings/channels/page.tsx`
- [ ] Create `shell/src/components/settings/ChannelCard.tsx`
- [ ] Card per channel: icon, name, status badge (green/yellow/red/gray)
- [ ] Status from `GET /api/channels/status`
- [ ] Expandable: click to show config form
- [ ] Cards: Telegram, Discord, Slack, WhatsApp, plus "More coming soon" for others
- **Output**: Channel overview with status

### T977 [US53] Channel setup forms
- [ ] Telegram: bot token input, allowFrom list, polling toggle
- [ ] Discord: bot token, guild ID
- [ ] Slack: app token, bot token
- [ ] WhatsApp: QR code display (when adapter supports it)
- [ ] Form validation (Zod + React Hook Form)
- [ ] Save updates config.json via settings API
- [ ] "Test Connection" button per channel
- **Output**: Visual channel configuration

### T978 [US53] Settings API -- channels
- [ ] Create `packages/gateway/src/routes/settings.ts`
- [ ] `GET /api/settings/channels` -- merged channel config + status
- [ ] `PUT /api/settings/channels/:id` -- update channel config (writes to config.json)
- [ ] `POST /api/settings/channels/:id/test` -- test channel connectivity
- **Output**: Channel settings CRUD API

### T979 [P] Gateway settings API -- agent
- [ ] `GET /api/settings/agent` -- agent identity + file list
- [ ] `PUT /api/settings/agent/identity` -- update display name, handle
- [ ] Files read/write via existing `/files/*` endpoints
- **Output**: Agent settings API

---

## Phase C: Skills + Cron (T980-T984)

### T980 [US54] Skills management page
- [ ] Create `shell/src/app/settings/skills/page.tsx`
- [ ] Create `shell/src/components/settings/SkillCard.tsx`
- [ ] Grid of skill cards: name, description (from frontmatter), status badge
- [ ] Status: Ready (green), Needs Config (yellow), Disabled (gray)
- [ ] Toggle switch per skill (enable/disable)
- [ ] Click card -> expand to show full skill content (markdown preview)
- [ ] Read from `/files/agents/skills/` (directory listing) + skill frontmatter parsing
- **Output**: Skills management UI

### T981 [P] [US54] Add skill
- [ ] "Add Skill" button -> dialog with:
  - [ ] File upload (.md file)
  - [ ] Paste content (textarea)
  - [ ] Template selection (from built-in templates)
- [ ] Saves to `~/agents/skills/{name}.md`
- **Output**: Users can add custom skills

### T982 [US55] Cron job management page
- [ ] Create `shell/src/app/settings/cron/page.tsx`
- [ ] Job list: name, schedule (human-readable + cron expression), next run, status badge
- [ ] Enable/disable toggle per job
- [ ] "Add Job" button -> create form
- [ ] Delete with confirmation
- [ ] Read from `GET /api/cron`
- **Output**: Cron job management UI

### T983 [US55] Cron job form
- [ ] Create `shell/src/components/settings/CronJobForm.tsx`
- [ ] Fields: name, description, schedule type (interval/cron/once), cron expression, message, delivery channel
- [ ] Cron expression helper: common presets (every hour, daily at 9am, weekly Monday, etc.)
- [ ] Preview next 5 runs
- [ ] POST `/api/cron` to create, PUT to update
- **Output**: Visual cron job creation

### T984 [P] [US55] Cron templates
- [ ] Pre-built templates: daily summary, weekly review, morning briefing, backup reminder
- [ ] Template cards in the create flow
- [ ] Click template -> pre-fill form
- **Output**: Quick cron job setup

---

## Phase D: Security + Plugins + System (T985-T990)

### T985 [US56] Security dashboard
- [ ] Create `shell/src/app/settings/security/page.tsx`
- [ ] "Run Audit" button -> `GET /api/security/audit`
- [ ] Findings list: severity icon (info/warn/critical), title, detail, remediation
- [ ] Summary bar: N critical, N warnings, N info
- [ ] Auto-run on page load (cached, manual refresh available)
- [ ] Requires 025-security T833 (audit API) -- show placeholder if not available
- **Output**: Security posture dashboard

### T986 [P] [US56] Exec rules editor
- [ ] List of shell command approval rules
- [ ] Per rule: pattern (glob/regex), action (allow/deny/ask)
- [ ] Add/remove/reorder rules
- [ ] Default action selector
- **Output**: Visual exec security configuration

### T987 [US57] Plugin management page
- [ ] Create `shell/src/app/settings/plugins/page.tsx`
- [ ] Create `shell/src/components/settings/PluginCard.tsx`
- [ ] List installed plugins: name, version, origin badge, status
- [ ] Capabilities summary: N tools, N hooks, N channels
- [ ] Install button -> URL or path input
- [ ] Uninstall with confirmation
- [ ] Per-plugin config editor (JSON)
- [ ] Requires 029-plugins T946 (plugins API) -- show placeholder if not available
- **Output**: Plugin management UI

### T988 [US57] System info page
- [ ] Create `shell/src/app/settings/system/page.tsx`
- [ ] System info: Matrix OS version, gateway status, uptime, home directory, Node version
- [ ] Health checks: gateway (green/red), each channel, kernel responsiveness
- [ ] From `GET /health` and `GET /api/system/info`
- **Output**: System health overview

### T989 [P] [US57] Log viewer
- [ ] Create `shell/src/components/settings/LogViewer.tsx`
- [ ] Streaming log display (WebSocket or polling from /api/logs)
- [ ] Filter by level: debug, info, warn, error
- [ ] Search/filter text input
- [ ] Auto-scroll toggle
- [ ] Monospace font (JetBrains Mono)
- **Output**: Log viewer in settings

### T990 [P] Theme + About
- [ ] Theme picker: System / Light / Dark radio group
- [ ] Persist preference (Zustand persist, same as existing)
- [ ] About section: Matrix OS logo, version, "Built with Claude Agent SDK"
- [ ] Link to matrix-os.com, GitHub repo
- **Output**: Theme and about info

---

## Checkpoint

1. Click Settings icon in dock -> settings opens with sidebar navigation.
2. Edit SOUL.md in Agent settings -> save -> agent personality changes in next chat.
3. Enter Telegram bot token in Channels -> test connection -> green badge.
4. Toggle a skill off in Skills -> agent no longer has that capability.
5. Create a cron job "Daily summary at 9am" -> appears in cron list with next run time.
6. Run security audit -> findings displayed with severity and remediation.
7. View installed plugins with their capabilities.
8. System page shows gateway uptime and health.
9. Cmd+, opens settings from anywhere.
10. Mobile: settings shows section cards, tap navigates to section.
