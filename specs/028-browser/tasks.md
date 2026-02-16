# Tasks: Browser Automation (Playwright)

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T900-T929
**Supersedes**: specs/019-browser/ (T690-T699)

## User Stories

- **US44**: "The OS can browse the web for me -- navigate, screenshot, extract data, fill forms"
- **US45**: "Browser output is safe -- external content can't inject into my agent's context"
- **US46**: "The agent can understand web pages semantically through accessibility snapshots"

---

## Phase A: MCP Server + Session (T900-T904)

### Tests (TDD -- write FIRST)

- [x] T900a [US44] Write `tests/mcp-browser/session-manager.test.ts`:
  - launch() creates a new browser session (mocked Playwright)
  - getActive() returns current session
  - close() shuts down browser
  - Auto-close after idle timeout
  - Lazy start: no browser process until first tool call
  - Only one session at a time

### T900 [US44] MCP browser server scaffold
- [x] Create `packages/mcp-browser/package.json` -- deps: `playwright`, `@anthropic-ai/sdk`
- [ ] Create `packages/mcp-browser/tsconfig.json`
- [x] Create `packages/mcp-browser/src/server.ts` -- MCP server with stdio transport
- [x] Register single `browser` tool (composite, action dispatch)
- [x] Add to `pnpm-workspace.yaml`
- **Output**: MCP server that starts and exposes browser tool

### T901 [US44] Session manager
- [x] Create `packages/mcp-browser/src/session-manager.ts`
- [x] `launch()`: start Chromium via Playwright (headless by default)
- [x] `getActive()`: return current session or undefined
- [x] `close()`: close browser, clear session
- [x] Lazy start: browser only launches on first action (not on server start)
- [x] Auto-close timer: configurable idle timeout (default: 5 min)
- [x] Activity tracking: reset timer on every action
- **Output**: Managed browser lifecycle

### T902 [US44] Chromium installation
- [ ] `pnpm --filter mcp-browser exec playwright install chromium` (only Chromium, ~150MB)
- [ ] Document: "browser requires explicit Playwright install"
- [x] Graceful error when Chromium not installed: "Run `pnpm mcp-browser install` to enable browser"
- **Output**: Chromium available for browser automation

### T903 [US44] Wire into kernel
- [x] When `config.browser.enabled`, add MCP server to kernel mcpServers:
  ```
  { name: "browser", command: "node", args: ["packages/mcp-browser/dist/server.js"] }
  ```
- [x] Browser config in `~/system/config.json`: `{ "browser": { "enabled": true, "headless": true, "timeout": 30000, "idleTimeout": 300000 } }`
- **Output**: Agent can access browser tool via MCP

### T904 [P] Chrome profile support
- [ ] Support named profiles (persist cookies, sessions across restarts)
- [ ] Profile directory: `~/data/browser-profiles/{name}/`
- [ ] Default profile: "default"
- **Output**: Browser sessions with persistent state

---

## Phase B: Core Actions (T905-T912)

### Tests (TDD -- write FIRST)

- [x] T905a [US46] Write `tests/mcp-browser/role-snapshot.test.ts`:
  - Extracts accessibility tree from page
  - Tree format is compact and readable
  - Includes roles, names, values, states
  - Handles empty pages
  - Large pages truncated to token budget

- [x] T906a [US44] Write `tests/mcp-browser/browser-tool.test.ts`:
  - navigate action opens URL, returns title
  - snapshot action returns accessibility tree
  - click action clicks element by selector
  - type action enters text into input
  - screenshot action saves file and returns path
  - evaluate action runs JS and returns result
  - Unknown action returns error
  - All output is wrapped (external content markers present)

### T905 [US46] Role snapshot (accessibility tree)
- [x] Create `packages/mcp-browser/src/role-snapshot.ts`
- [x] Use Playwright's `page.accessibility.snapshot()` for accessibility tree
- [x] Format as indented text with role, name, value, state
- [x] Token budget: truncate large trees to configurable max chars (default: 20,000)
- [x] Filter noise: skip decorative/presentation roles
- **Output**: Semantic page understanding for the agent

### T906 [US44] navigate + snapshot actions
- [x] `navigate`: go to URL, wait for load, return { title, url }
- [x] `snapshot`: capture accessibility tree, wrap as external content, return
- [x] Combine: navigate always returns snapshot alongside (so agent sees page after navigating)
- **Output**: Core browse loop: navigate -> see page

### T907 [US44] click + type + select actions
- [x] `click`: click by CSS selector OR by role+name (from snapshot)
- [x] `type`: clear field, type text into selector
- [x] `select`: select option from dropdown by value or label
- [x] All actions return updated snapshot after interaction
- **Output**: Form interaction

### T908 [US44] screenshot + PDF actions
- [x] Create `packages/mcp-browser/src/screenshot.ts`
- [x] `screenshot`: capture page, save to `~/data/screenshots/{timestamp}.png`
- [x] Options: fullPage (default: true), element selector
- [x] `pdf`: save page as PDF to `~/data/screenshots/{timestamp}.pdf`
- [x] Return file path (served via gateway `/files/data/screenshots/`)
- **Output**: Visual page capture

### T909 [US44] evaluate action
- [x] Run arbitrary JavaScript in page context via `page.evaluate()`
- [x] Return serializable result (JSON)
- [ ] Timeout: configurable (default: 5s for evaluation)
- [x] Wrap result as external content
- **Output**: Programmatic page interaction

### T910 [US44] wait + scroll actions
- [x] `wait`: wait for selector to appear, or navigation to complete
- [x] `scroll`: scroll page or specific element (up/down/to-element)
- [x] Configurable timeout for wait (default: 30s)
- **Output**: Dynamic page interaction

### T911 [P] [US44] Tab management
- [x] `tabs`: list all open tabs (title, url per tab)
- [x] `tab_new`: open new tab (optionally navigate to URL)
- [x] `tab_close`: close tab by index
- [x] `tab_switch`: switch active tab by index
- **Output**: Multi-tab browsing

### T912 [P] [US44] Console message reading
- [x] `console`: return recent console messages (log, warn, error)
- [ ] Filter by level
- [x] Wrap as external content
- **Output**: Debugging visibility for the agent

---

## Phase C: Security + Integration (T913-T917)

### Tests (TDD -- write FIRST)

- [ ] T913a [US45] Write `tests/mcp-browser/security.test.ts`:
  - Blocks navigation to file:// URLs
  - Blocks navigation to data: URLs
  - Blocks navigation to private IPs (127.0.0.1, 192.168.x, etc.)
  - Blocks metadata endpoints (169.254.169.254)
  - Allows navigation to public URLs
  - All browser output contains external content markers

### T913 [US45] URL validation
- [ ] Create `packages/mcp-browser/src/security.ts`
- [ ] Block `file://`, `data:`, `javascript:` URIs
- [ ] Block private IPs and metadata endpoints (reuse SSRF guard logic from 025)
- [ ] Configurable allowlist for internal URLs (e.g., localhost:3000 for testing)
- **Output**: Browser cannot access internal/dangerous URLs

### T914 [US45] External content wrapping
- [x] All browser output (snapshots, console, evaluate results, page text) wrapped
- [x] Use `wrapExternalContent({ source: "browser", includeWarning: true })` from 025
- [ ] If 025 not yet shipped, inline minimal wrapper with TODO
- **Output**: Browser content defensively wrapped

### T915 [US44] Screenshot file management
- [x] Screenshots saved to `~/data/screenshots/` (Everything Is a File)
- [x] Auto-create directory on first screenshot
- [x] Served via existing `/files/data/screenshots/*` gateway route
- [ ] Cleanup: optional max age (delete screenshots older than N days)
- **Output**: Screenshots accessible from shell and API

### T916 [P] Agent prompt update
- [ ] Update system prompt to mention browser capability when enabled
- [ ] Brief: "You have a web browser. Use it to navigate pages, fill forms, take screenshots. Use `snapshot` to understand page content."
- [ ] Mention role snapshot as the preferred way to understand pages (not raw HTML)
- **Output**: Agent knows about browser

### T917 [P] Docker Playwright support
- [ ] Add optional layer to Dockerfile with Playwright deps (libnss3, libatk-bridge2.0-0, etc.)
- [ ] Playwright provides dependency installer: `npx playwright install-deps chromium`
- [ ] Build arg: `INSTALL_BROWSER=true` to include browser deps
- **Output**: Browser works in Docker deployments

---

## Checkpoint

1. "Go to matrix-os.com and tell me what you see" -- agent navigates, takes snapshot, describes the page.
2. "Take a screenshot of the page" -- screenshot saved, displayed in chat.
3. "Fill in the signup form with test data" -- agent uses click + type to fill form fields.
4. "What does the console show?" -- agent reads console messages.
5. Agent tries to navigate to `file:///etc/passwd` -- blocked.
6. Agent tries to navigate to `http://169.254.169.254/` -- blocked.
7. All browser output in chat shows external content markers.
8. `bun run test` passes (browser tests use mocked Playwright).
