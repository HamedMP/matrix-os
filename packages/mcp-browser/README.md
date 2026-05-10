# @matrix-os/mcp-browser

Browser automation MCP server for Matrix OS. Provides web browsing, screenshots, text extraction, and search via Playwright.

## Setup

Playwright is an optional dependency (~300MB for Chromium). Install it only when browser automation is needed:

```bash
pnpm --filter @matrix-os/mcp-browser exec playwright install chromium
```

## Configuration

Enable browser in `~/system/config.json`:

```json
{
  "browser": {
    "enabled": true,
    "headless": true,
    "defaultProfile": "default",
    "timeout": 30000
  }
}
```

When `enabled` is `false` (default), the kernel skips loading the browser MCP server entirely.

## MCP Tools

### browser

| Parameter | Type | Description |
|-----------|------|-------------|
| action | `launch` \| `close` \| `navigate` \| `snapshot` \| `click` \| `type` \| `select` \| `scroll` \| `evaluate` \| `wait` \| `screenshot` \| `pdf` \| `tabs` \| `tab_new` \| `tab_close` \| `tab_switch` \| `console` \| `status` | What to do |
| profile | string | Persistent browser profile name (optional, default `default`) |
| url | string | URL for navigate or tab_new |
| selector | string | CSS selector for click/type/select/wait |
| role | string | ARIA role for role-based click |
| name | string | Accessible name for role-based click |
| text | string | Text for type action |
| value | string | Select value or tab index |
| expression | string | JavaScript expression for evaluate |
| timeout | number | Wait timeout in milliseconds |
| full_page | boolean | Full-page screenshot flag |
| path | string | Relative save path under `~/data/screenshots/` for screenshot/pdf |

**Actions:**
- **navigate**: Opens URL and returns title, final URL, and accessibility snapshot
- **screenshot**: Captures page screenshot, saves to `~/data/screenshots/`
- **snapshot**: Returns an accessibility tree wrapped as untrusted external content
- **click/type/select/scroll/wait**: Interact with dynamic pages and return updated page state
- **tabs/tab_new/tab_close/tab_switch**: Manage browser tabs
- **console**: Reads recent browser console messages

## Persistent Login Profiles

Browser sessions use a Playwright persistent context. The default profile stores cookies, local storage, and login state in:

```text
~/data/browser-profiles/default/
```

Use a named profile when a tool or task needs its own login lane:

```json
{
  "action": "navigate",
  "profile": "work",
  "url": "https://example.com/login"
}
```

Profile names must match lowercase slugs (`default`, `work`, `github-work`). Switching profiles closes the active browser process before opening the next profile, so Matrix keeps a single bounded browser session per instance. Browser profile directories are excluded from home mirror sync because they contain cookies, login databases, and transient browser lock/cache files.

## Security

- Navigation accepts only `http` and `https` URLs.
- Local, private, link-local, multicast, documentation, and internal host targets are blocked before navigation.
- Page and tab network requests are routed through the same guard so public pages cannot fetch private/internal resources through the agent browser.
- Hostname URLs are DNS-preflighted; this is not DNS pinning, so there is residual DNS-rebinding risk until Matrix has a browser dispatcher that pins resolved addresses.
- Screenshot/PDF paths are confined to `~/data/screenshots/`.
- Browser output is wrapped as untrusted external content before it reaches the agent.

## Docker

When running in Docker, Playwright needs system dependencies. Use the Playwright Docker base image or install deps:

```dockerfile
RUN npx playwright install-deps chromium
RUN npx playwright install chromium
```

## Graceful Degradation

If Playwright is not installed, the browser MCP server will not load. The kernel logs no error and continues without browser tools. Users see no disruption.
