# Matrix OS: Concrete Improvement Recommendations

**Date**: 2026-02-13
**Agent**: improvements-advisor
**Scope**: 10-area analysis of Matrix OS codebase, specs, and competitive landscape

---

## 1. Architecture

### 1a. Dispatcher needs a queue, not fire-and-forget

**Problem**: `packages/gateway/src/dispatcher.ts` has no concurrency control. If two WebSocket clients or channel adapters call `dispatcher.dispatch()` simultaneously, two kernel sessions run in parallel against the same home directory. The Agent SDK's `query()` calls write to the file system -- concurrent writes to `~/system/modules.json`, `~/system/state.md`, etc. will corrupt state.

**Fix**: Add a dispatch queue in `dispatcher.ts`:

```typescript
// packages/gateway/src/dispatcher.ts
const queue: Array<{
  message: string;
  sessionId?: string;
  onEvent: (e: KernelEvent) => void;
  resolve: () => void;
  reject: (e: Error) => void;
}> = [];
let running = false;

async function processQueue() {
  if (running || queue.length === 0) return;
  running = true;
  const { message, sessionId, onEvent, resolve, reject } = queue.shift()!;
  try {
    for await (const event of spawnKernel(message, config)) {
      onEvent(event);
    }
    resolve();
  } catch (e) {
    reject(e as Error);
  } finally {
    running = false;
    processQueue();
  }
}
```

This is critical before adding channels (spec 006) since Telegram + web shell + cron could all dispatch simultaneously.

### 1b. Hooks are no-ops -- prioritize implementing them

**Problem**: In `packages/kernel/src/hooks.ts`, 6 of 8 hooks are empty no-ops with `// In full implementation` comments: `updateStateHook`, `logActivityHook`, `gitSnapshotHook`, `persistSessionHook`, `onSubagentComplete`, `notifyShellHook`, `preCompactHook`. These are registered in `packages/kernel/src/options.ts` lines 69-108 but do nothing.

**Priority order for implementation**:
1. `gitSnapshotHook` -- most critical for safety. Without git snapshots before mutations, the self-healing/rollback guarantee is hollow. Use `execFileSync("git", ["add", "-A"], { cwd: homePath })` and `execFileSync("git", ["commit", "-m", "..."])`.
2. `logActivityHook` -- needed for observability. Append to `~/system/activity.log` with structured format.
3. `updateStateHook` -- needed for prompt accuracy. Regenerate `~/system/state.md` after file mutations so the next kernel invocation has current state.
4. `persistSessionHook` -- needed for session resume across restarts.

### 1c. System prompt grows unbounded

**Problem**: `packages/kernel/src/prompt.ts` (`buildSystemPrompt()`) reads activity.log's last 50 lines, all modules, all knowledge file names, and user profile. As the system accumulates activity and modules, this prompt will exceed the 7K token budget from the constitution. There is no token counting or truncation.

**Fix**: Add a token estimator (4 chars ~= 1 token) and enforce the 7K cap:
- Activity: cap at 20 most recent lines, not 50
- Modules: summarize as a count + names, not full JSON
- Add a `truncateToTokenBudget(sections, maxTokens)` utility
- Consider moving detailed state to a "demand-paged" knowledge file the kernel reads only when needed

### 1d. Missing rate limiting on gateway endpoints

**Problem**: `packages/gateway/src/server.ts` has `app.use("*", cors())` but no rate limiting. The `/api/message` endpoint (line 247) invokes the full kernel on any POST. Without auth or rate limits, anyone can trigger expensive Opus API calls.

**Fix**: Add rate limiting middleware before the kernel-invoking routes:
```typescript
import { rateLimiter } from "hono-rate-limiter";
app.use("/api/message", rateLimiter({ windowMs: 60000, limit: 10 }));
app.use("/ws", rateLimiter({ windowMs: 60000, limit: 5 }));
```

Also: the `MATRIX_AUTH_TOKEN` env var mentioned in CLAUDE.md is never checked in the actual server code. Add bearer token validation middleware for cloud deployment.

---

## 2. Developer Experience

### 2a. CLI scaffolding commands

The spec for skills (005) describes creating skill files manually. Add CLI scaffolding commands:
```bash
# packages/kernel/src/cli/scaffold.ts
matrixos create-skill weather --triggers "weather,forecast,temperature"
# -> Creates ~/agents/skills/weather.md with frontmatter template

matrixos create-agent my-agent --model sonnet --tools "Read,Write,Bash"
# -> Creates ~/agents/custom/my-agent.md with frontmatter template
```

### 2b. Dev mode with hot reload for generated apps

Currently, generated HTML apps in `~/apps/` are served statically via the `/files/*` endpoint. When the kernel edits an app file, the browser does not know to reload the iframe.

**Fix**: The file watcher (`packages/gateway/src/watcher.ts`) already broadcasts `file:change` events. In `shell/src/components/AppViewer.tsx`, listen for `file:change` events matching the app's path and reload the iframe:
```typescript
// shell/src/components/AppViewer.tsx
useFileWatcher((change) => {
  if (change.path.includes(appPath)) {
    iframeRef.current?.contentWindow?.location.reload();
  }
});
```

### 2c. Error overlay for generated apps

When a generated HTML app has a JavaScript error, the iframe shows nothing or a cryptic console error. Add an error boundary that catches iframe errors and shows them inline with a "Fix it" button that sends the error back to the kernel.

### 2d. Structured app template gallery

The home template (`home/apps/.gitkeep`) starts empty. Pre-seed 3-5 template apps that demonstrate patterns:
- `home/apps/hello.html` -- minimal working app with theme integration
- `home/apps/todo.html` -- CRUD app using the bridge API (`window.MatrixOS`)
- `home/apps/chart.html` -- data visualization using Chart.js CDN

These serve as both examples for developers and immediate value for new users (see section 4).

### 2e. Plugin/extension system for the gateway

The gateway (`packages/gateway/src/server.ts`) is a monolith. As channels, cron, and more features get added, it will grow unwieldy. Add a plugin registration pattern:
```typescript
interface GatewayPlugin {
  name: string;
  register(app: Hono, config: GatewayConfig): void;
}
```
Each channel adapter, the cron service, and the heartbeat become plugins. The `createGateway()` function takes a `plugins` array.

---

## 3. Security Model

### 3a. The "call center" model needs concrete primitives

The vision documents describe the "call center" security model for AI-to-AI communication but the codebase has no implementation. Here are the specific primitives needed:

**Privacy manifest** (`~/system/privacy.json`):
```json
{
  "publicFields": ["name", "skills", "timezone"],
  "shareableData": ["~/data/public/*"],
  "blockedSenders": [],
  "rateLimit": { "external": 10, "windowMs": 3600000 },
  "requireApproval": ["file_access", "schedule_meeting"]
}
```

**Sandboxed context builder**: When processing an external request, `buildSystemPrompt()` should accept a `mode: "public" | "private"` parameter. In public mode, it reads only `~/system/ai-profile.md` and files listed in `privacy.json.shareableData`, NOT the full state/activity/knowledge.

**Approval queue**: External requests that require elevated access (meeting scheduling, data sharing) go into an approval queue. The owner sees them in the shell's ActivityFeed or gets a Telegram notification.

### 3b. The safety guard hook is bypassable

`packages/kernel/src/hooks.ts` blocks `rm -rf` patterns in Bash, but the kernel runs with `bypassPermissions: true` (`packages/kernel/src/options.ts` line 50-51). The agent can use alternative destructive patterns not in `DANGEROUS_PATTERNS` (e.g., `find / -delete`, `shred`, `> /important/file`).

**Fix**: Switch to an allowlist approach for Bash commands rather than a denylist. Only allow commands that operate within `homePath`:
```typescript
const cmd = String(toolInput.command);
if (!cmd.includes(homePath) && !isSafeSystemCommand(cmd)) {
  return { hookSpecificOutput: { permissionDecision: "deny" } };
}
```

### 3c. Add Content Security Policy for generated apps

The `/files/*` endpoint (`server.ts` line 258) serves generated HTML with no CSP headers. A malicious or buggy generated app could exfiltrate data.

**Fix**: Add CSP headers:
```typescript
headers: {
  "Content-Security-Policy":
    "default-src 'self' https://esm.sh https://unpkg.com https://cdnjs.cloudflare.com; " +
    "script-src 'self' 'unsafe-inline' https://esm.sh https://unpkg.com https://cdnjs.cloudflare.com; " +
    "connect-src 'self' http://localhost:4000"
}
```

### 3d. The IPC server has no caller identity

`packages/kernel/src/ipc-server.ts` hardcodes `from: "agent"` for all messages (line 126) and `claimTask(db, task_id, "agent")` (line 68). When multiple sub-agents run, there is no way to distinguish which agent did what. Pass the agent name through the MCP server context.

---

## 4. First-Run Experience

### 4a. The blank canvas problem is the biggest UX risk

The vision documents explicitly state "You open Matrix OS and you see almost nothing -- a clean, quiet surface." This sounds poetic but is a UX cliff. Lovable and Bolt solve this with immediate template options. Replit shows you what other people built.

**Concrete fix -- staged onboarding flow**:

**Step 1: Guided introduction** (first 30 seconds):
When `~/system/state.md` contains the default `Fresh install` marker, the kernel sends an introduction message:
```
Welcome to Matrix OS. I'm your AI operating system.

I can build apps from conversation, manage your files, and connect to
your messaging platforms.

Here are some things you can try:
- "Build me a task tracker"
- "What's the weather in Stockholm?"
- "Show me what you can do"
```

Implement this in `packages/kernel/src/prompt.ts` by adding an `isFirstBoot` check and appending onboarding instructions to the system prompt.

**Step 2: Pre-seeded starter apps** (already partly in spec 010):
- `home/apps/welcome.html` -- interactive getting-started guide
- `home/modules/hello-world/` -- already exists, good
- Add `home/apps/system-monitor.html` -- shows module health, costs, activity

**Step 3: Suggestion chips** (`shell/src/components/SuggestionChips.tsx`):
The component already exists but shows static chips. Make them context-aware:
- First boot: "Build a task tracker", "Customize my theme", "Set up Telegram"
- After first app: "Modify [app name]", "Build something else", "Connect a channel"
- After inactivity: "What have I been working on?", "Show my recent apps"

### 4b. Add a "demo mode" that does not require an API key

For the hackathon and marketing site, a demo mode where pre-recorded kernel responses play back would let people experience the OS without an API key. Store demo conversations in `home/system/demo-conversations/` and replay them.

---

## 5. Offline / Degraded Mode

### 5a. Currently: no API key = completely dead OS

Without `ANTHROPIC_API_KEY`, the gateway starts but every message errors. The shell shows nothing useful.

**Tiered degradation strategy**:

**Tier 1 -- No API key at all**:
- Shell renders normally, file browser works, terminal works
- Chat shows: "No API key configured. Set ANTHROPIC_API_KEY to enable AI features."
- Manual file editing, theme changes, and app viewing still work
- System prompt builder still loads state (useful for debugging)

**Tier 2 -- API key but no internet**:
- Queue messages and process them when connectivity returns
- Show "Offline -- your message will be sent when connected" in the chat panel
- File watcher, terminal, and app viewer continue to work

**Tier 3 -- API key with rate limiting/quota exceeded**:
- Show cost dashboard: "$5.00 of $5.00 used"
- Offer to switch to a cheaper model: "Switch to Haiku for lighter tasks?"
- Queue non-urgent messages

### 5b. Local model fallback (future)

For Tier 1/2, offer an Ollama integration path. The `config.json` could support:
```json
{
  "kernel": {
    "model": "claude-opus-4-6",
    "fallback": { "provider": "ollama", "model": "llama3.3:70b" }
  }
}
```
This is post-hackathon but the architecture should support swappable model providers from the start. The `kernelOptions()` function in `packages/kernel/src/options.ts` already takes a `model` parameter -- extend it with a provider abstraction.

---

## 6. Performance

### 6a. Kernel response time is the critical bottleneck

Opus 4.6 takes 5-30 seconds to respond. During that time, the shell must feel alive.

**Immediate wins in `shell/src/components/`**:

1. **Streaming feedback** (partially done in `ResponseOverlay.tsx`): The overlay shows streaming text, good. But add a progress indicator that shows which tool the kernel is using. `kernel:tool_start` events already carry the tool name -- show "Reading files...", "Writing app...", "Searching web..." in the overlay header.

2. **Optimistic UI updates**: When the user says "change theme to dark", immediately apply a provisional dark theme in the shell while the kernel processes. If the kernel produces a different result, reconcile. The `useTheme.ts` hook already watches `theme.json` -- add a `pendingTheme` state.

3. **Preload knowledge files**: `buildSystemPrompt()` reads files synchronously on every dispatch. Cache the prompt assembly and invalidate only when the watcher detects changes to `~/system/` or `~/agents/`. This eliminates ~10-50ms of file I/O per kernel invocation.

4. **WebSocket heartbeat/ping**: The `useSocket.ts` hook polls connection status every 1 second (`setInterval(checkConnection, 1000)` at line 81). Replace with WebSocket ping/pong frames, which are lighter and more reliable.

### 6b. Module proxy adds latency

The `/modules/:name/*` route in `server.ts` (line 351) does a full `fetch()` proxy to the module's local port on every request. For static assets, this adds unnecessary latency.

**Fix**: For HTML/CSS/JS assets, serve them directly from the module's directory via the `/files/*` endpoint. Only proxy dynamic requests (API calls, WebSocket connections).

---

## 7. Data Evolution / Schema Migration

### 7a. Generated apps have no migration story

When the kernel generates `~/data/tasks/items.json` for a task tracker, and the user later says "add a priority field to my tasks", the kernel edits the app HTML but the existing JSON data does not have the `priority` field. This will either crash the app or silently lose data.

**Solution -- migration files**:

Add a convention where each app's data directory includes a `_schema.json`:
```json
{
  "version": 2,
  "fields": {
    "id": "string",
    "title": "string",
    "done": "boolean",
    "priority": "number"
  },
  "migrations": [
    { "from": 1, "to": 2, "addFields": { "priority": 3 } }
  ]
}
```

When the builder agent modifies an app, it also writes a migration. The app's bridge API (`window.MatrixOS.readData()`) checks schema version and applies migrations on read.

**Implementation in bridge** (`packages/gateway/src/server.ts`, `/api/bridge/data` endpoint, line 287):
```typescript
if (body.action === "read") {
  const schema = tryReadSchema(dataDir);
  const data = readData(filePath);
  return c.json(schema ? migrateData(data, schema) : data);
}
```

### 7b. SQLite for structured data, not just IPC

The current SQLite database (`system/matrix.db`) is only used for IPC (tasks and messages) via `packages/kernel/src/db.ts` and `packages/kernel/src/schema.ts`. Generated apps that need structured data use JSON files.

For apps that grow beyond simple JSON (e.g., CRM with 1000+ records), the bridge API should support SQLite:
```typescript
window.MatrixOS.query("SELECT * FROM leads WHERE status = ?", ["active"]);
```
Each app gets its own SQLite database in `~/data/{appName}/app.db`. The bridge endpoint proxies queries.

---

## 8. Testing Generated Apps

### 8a. The testing gap is real

The constitution mandates 99-100% test coverage for kernel/gateway, but generated apps (the primary product) have zero testing. This is a fundamental asymmetry.

**Solution -- three-layer testing for generated apps**:

**Layer 1: Structural validation** (immediate, add to builder agent prompt):
After the builder generates an app, add verification steps:
- Validate HTML syntax (no unclosed tags)
- Verify all CDN imports resolve (`curl -s -o /dev/null -w "%{http_code}" <url>`)
- Confirm bridge API calls use correct endpoints
- Check that theme CSS variables are used (no hardcoded colors)

This is already partially in the builder prompt (`packages/kernel/src/agents.ts` line 152-158) but needs enforcement.

**Layer 2: Visual regression testing** (medium-term):
After generating an app, take a screenshot using Playwright and store it in `~/data/{appName}/.screenshots/`. On modification, compare before/after. If the visual diff exceeds a threshold, flag for review.

**Layer 3: Behavioral testing via the kernel** (aspirational):
When the user says "test my task tracker", spawn a tester sub-agent that:
1. Opens the app in a headless browser (Playwright)
2. Interacts with it (create task, mark done, delete)
3. Verifies the data files were correctly updated
4. Reports results

Add a `tester` agent definition in `packages/kernel/src/agents.ts` alongside builder/healer/researcher/deployer/evolver.

### 8b. Integration test for the full kernel->app pipeline

Currently, tests in `tests/kernel/` test individual functions, not the end-to-end flow. Add an integration test that:
1. Calls `spawnKernel("build me a counter app", config)` with haiku
2. Collects all events
3. Verifies a file was written to `~/apps/`
4. Verifies the HTML is valid
5. Verifies `modules.json` was updated

This tests the actual product loop, not just internal functions.

---

## 9. Monetization

### 9a. API cost pass-through is the baseline model

The spec in `specs/008-cloud/spec.md` describes a free tier of $5 in AI credits. This is the right starting point. Specific tiers:

| Tier | Price | AI Credits | Storage | Channels | Notes |
|------|-------|-----------|---------|----------|-------|
| Free | $0 | $5 included | 1GB | Web shell only | No custom domain |
| Pro | $20/month | Unlimited (capped at $50/mo platform cost) | 10GB | All channels | Custom subdomain |
| Team | $10/user/month (min 5) | Shared pool | 50GB shared | All + internal marketplace | Per-user home dirs |

### 9b. Marketplace revenue share

Apps in the marketplace use a 70/30 split (developer gets 70%). Monetization options for app developers:
- One-time purchase (app file is transferred)
- Subscription (app checks license via bridge API)
- Freemium (basic app free, premium features gated)

### 9c. Enterprise: self-hosted license

For companies that want Matrix OS on their own infrastructure, offer a self-hosted license with SLA, support, and custom integrations. Price: $500-2000/month depending on seats.

### 9d. What competitors charge (for reference)

- **Lovable**: $20/month hobby, $50/month pro (250 messages). Hit $100M ARR in 8 months.
- **Replit**: $25/month pro (unlimited AI). Revenue jumped $10M to $100M in 9 months after Agent launch.
- **Bolt**: $10-50/month range.
- **Cursor**: $20/month pro. Valued at $9 billion (2025).

Matrix OS's $20/month is competitive, especially with the unique multi-channel + always-on + AI identity angle that none of these competitors offer.

---

## 10. Community / Ecosystem

### 10a. The app marketplace is the community flywheel

Build the marketplace early, even if it starts as a curated list of JSON files:

`home/system/marketplace.json`:
```json
{
  "featured": [
    {
      "name": "expense-tracker",
      "author": "@hamed",
      "description": "Track expenses by category with monthly charts",
      "stars": 42,
      "install": "git clone https://github.com/..."
    }
  ]
}
```

The kernel command "browse marketplace" reads this file and presents options. "Install expense tracker" clones the app into `~/apps/`.

### 10b. GitHub as the distribution layer

Since everything is files, apps can be GitHub repos. The marketplace is a curated registry (like npm) pointing to GitHub repos. Users install via git:
```
matrixos install github.com/user/matrix-os-expense-tracker
```
This leverages existing developer workflows rather than building a custom distribution system.

### 10c. Template gallery for first-time builders

"Build an app" is intimidating. "Customize this template" is approachable. Create a gallery of 10-20 starter templates:
- Personal CRM
- Expense tracker
- Habit tracker
- Recipe organizer
- Bookmark manager
- Daily journal
- Pomodoro timer

These are HTML files in `home/templates/` (the directory already exists with a `.gitkeep`). The onboarding flow suggests them.

### 10d. Developer documentation site

The `docs/` directory has SDK reference docs but no developer guide for building Matrix OS apps. Create `docs/app-dev-kit/`:
- `getting-started.md` -- build your first app
- `bridge-api.md` -- `window.MatrixOS` reference
- `theme-integration.md` -- CSS custom properties
- `data-storage.md` -- using the bridge data endpoint
- `publishing.md` -- sharing and distributing apps

### 10e. Community server on Matrix protocol

Since Matrix protocol is core to the vision, the community should live on Matrix. Create a `#matrixos:matrix-os.com` room. Bridge it to Discord for broader reach.

---

## Prioritized Implementation Order (for hackathon)

### Must do before demo (safety + demo quality)
1. Dispatch queue in `packages/gateway/src/dispatcher.ts` (prevents concurrent corruption)
2. First-boot onboarding message in system prompt
3. Pre-seeded starter apps in `home/` template
4. Implement `gitSnapshotHook` in `packages/kernel/src/hooks.ts` (safety net for self-healing demo)
5. Auth token validation in gateway (for cloud deployment)

### Should do for polish
6. Streaming tool indicators in `shell/src/components/ResponseOverlay.tsx`
7. Context-aware suggestion chips in `shell/src/components/SuggestionChips.tsx`
8. System prompt token budgeting in `packages/kernel/src/prompt.ts`
9. Rate limiting on gateway endpoints

### Nice to have
10. Error overlay for generated apps
11. Offline degraded mode (tiered strategy)
12. Demo mode (pre-recorded conversations for marketing site)

---

## Key Insight from Competitor Analysis

Lovable hit $100M ARR in 8 months. Replit went from $10M to $100M in 9 months after launching Agent. Both prove the market for AI-generated software is real and enormous.

Matrix OS differentiates on three axes competitors do not cover:
1. **Persistence** -- generated apps are files you own, not ephemeral previews
2. **Multi-channel** -- same OS accessible from browser, Telegram, WhatsApp, Discord
3. **Identity** -- unified @handle across all interactions, AI-to-AI communication

The biggest risk is trying to ship all of Web 4 for the hackathon instead of nailing the core loop: "speak to OS -> software appears -> it works -> it persists." Everything else can follow.

---

## Sources

- [AI App Builder Comparison 2026](https://getmocha.com/blog/best-ai-app-builder-2026/)
- [Vibe Coding Landscape 2026](https://www.creolestudios.com/vibe-coding-comparison-for-decision-makers/)
- [2026 AI Coding Platform Wars](https://medium.com/@aftab001x/the-2026-ai-coding-platform-wars-replit-vs-windsurf-vs-bolt-new-f908b9f76325)
- [OpenDAN Personal AI OS](https://github.com/fiatrete/OpenDAN-Personal-AI-OS)
- [AIOS: AI Agent Operating System](https://github.com/agiresearch/AIOS)
- [Local AI Agents 2026](https://aimultiple.com/local-ai-agent)
- [Best Local LLMs for Offline Use 2026](https://iproyal.com/blog/best-local-llms/)
- [JetBrains AI Assistant Offline Mode](https://www.jetbrains.com/help/ai-assistant/switching-to-offline-mode.html)
- [Developer Experience Metrics 2026](https://dasroot.net/posts/2026/01/developer-experience-metrics-improvement/)
