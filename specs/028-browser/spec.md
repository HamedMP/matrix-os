# 028: Browser Automation (Playwright)

**Supersedes**: `specs/019-browser/` (minimal sketch, T690-T699)

## Problem

The kernel cannot interact with the web beyond fetching static content. Users need the agent to: navigate dynamic pages, fill forms, take screenshots, extract structured data from SPAs, and act on web UIs. Moltbot has full Playwright integration with CDP, role snapshots (accessibility tree), a composite browser_tool with action dispatch, and security wrapping of all browser output.

## Solution

A Playwright-based browser automation module in `packages/mcp-browser/` running as a separate MCP server process (keeps the heavy ~300MB Playwright dependency out of the core kernel). The agent accesses the browser through a single composite `browser` tool with action dispatch. All browser output goes through external content wrapping (025 security). Screenshots saved to `~/data/screenshots/` (Everything Is a File).

## Design

### Architecture

```
Kernel (Agent SDK)
  |-- mcpServers: [{ name: "browser", ... }]
  |
  +---> MCP Browser Server (packages/mcp-browser/)
          |-- Playwright (Chromium)
          |-- Session Manager (browser lifecycle, profile support)
          |-- Role Snapshot (accessibility tree extraction)
          |-- Screenshot Manager (save to ~/data/screenshots/)
          |-- Security: all output wrapped as external content
```

### Browser Tool (Single Composite Tool)

```typescript
type BrowserAction =
  | "launch"           // start browser session
  | "close"            // close browser
  | "navigate"         // go to URL
  | "screenshot"       // capture page
  | "snapshot"         // accessibility tree (role snapshot)
  | "click"            // click element by selector or role
  | "type"             // type into input
  | "select"           // select from dropdown
  | "scroll"           // scroll page or element
  | "evaluate"         // run JS in page context
  | "extract"          // extract text/data from page
  | "wait"             // wait for selector/navigation
  | "tabs"             // list open tabs
  | "tab_new"          // open new tab
  | "tab_close"        // close tab
  | "tab_switch"       // switch to tab
  | "pdf"              // save page as PDF
  | "console"          // read console messages
  | "status"           // browser session status

interface BrowserToolInput {
  action: BrowserAction;
  url?: string;              // for navigate
  selector?: string;         // CSS selector for click/type/extract
  role?: string;             // ARIA role for click (from snapshot)
  name?: string;             // accessible name for click (from snapshot)
  text?: string;             // for type
  value?: string;            // for select
  expression?: string;       // for evaluate (JS)
  timeout?: number;          // wait timeout (default: 30s)
  fullPage?: boolean;        // for screenshot (default: true)
  path?: string;             // save path for screenshot/pdf
}

interface BrowserToolResult {
  action: BrowserAction;
  success: boolean;
  title?: string;
  url?: string;
  content?: string;          // wrapped as external content
  screenshotPath?: string;
  error?: string;
}
```

### Role Snapshot (Accessibility Tree)

Instead of returning raw HTML (huge, noisy), the browser returns an **accessibility tree** -- the same tree screen readers use. This gives the agent a semantic, compact view of the page:

```
document "Matrix OS - Settings"
  navigation "Main"
    link "Home" [href="/"]
    link "Settings" [href="/settings", current]
  main
    heading "Settings" [level=1]
    region "Profile"
      textbox "Display name" [value="Hamed"]
      button "Save"
    region "Channels"
      list
        listitem
          text "Telegram: connected"
          button "Disconnect"
```

This is much more useful for the agent than raw DOM. ~10-50x smaller than HTML.

### Session Management

```typescript
interface BrowserSession {
  id: string;
  browser: Browser;          // Playwright browser instance
  page: Page;                // active page
  profile?: string;          // Chrome profile name
  createdAt: number;
  lastActivity: number;
}

class SessionManager {
  launch(opts?: { profile?: string; headless?: boolean }): Promise<BrowserSession>;
  getActive(): BrowserSession | undefined;
  close(): Promise<void>;
  // Lazy start: browser only launches on first tool call
  // Auto-close: after idle timeout (configurable, default: 5 min)
}
```

### Security

- All browser output (snapshots, console, page text) wrapped with `wrapExternalContent({ source: "browser" })` + warning
- SSRF guard on navigate URLs (block internal IPs, metadata endpoints)
- No `file://` or `data:` URI navigation
- Page JavaScript sandboxed (Playwright's default isolation)
- Screenshots saved to controlled path only (`~/data/screenshots/`)

## Dependencies

- 025-security T820 (external content wrapping) -- for output wrapping
- 025-security T825 (SSRF guard) -- for URL validation
- Playwright (~300MB, only installed when browser enabled)

## File Locations

```
packages/mcp-browser/
  package.json               # deps: playwright, @anthropic-ai/sdk
  tsconfig.json
  src/
    server.ts                # MCP server entry point
    browser-tool.ts          # composite tool with action dispatch
    session-manager.ts       # browser lifecycle
    role-snapshot.ts         # accessibility tree extraction
    screenshot.ts            # screenshot save + serve
    security.ts              # URL validation, output wrapping
tests/
  mcp-browser/
    browser-tool.test.ts     # tool action tests (mocked Playwright)
    role-snapshot.test.ts    # snapshot formatting tests
    session-manager.test.ts  # lifecycle tests
```
