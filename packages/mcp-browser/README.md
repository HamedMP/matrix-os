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
    "timeout": 30000
  }
}
```

When `enabled` is `false` (default), the kernel skips loading the browser MCP server entirely.

## MCP Tools

### browse_web

| Parameter | Type | Description |
|-----------|------|-------------|
| action | `navigate` \| `screenshot` \| `extract` \| `search` | What to do |
| url | string | URL for navigate/screenshot/extract |
| selector | string | CSS selector for extract (optional, defaults to full page) |
| query | string | Search query for search action |
| save_as | string | Custom screenshot filename without extension |

**Actions:**
- **navigate**: Opens URL, returns title, status code, and first 2000 chars of text
- **screenshot**: Captures page screenshot, saves to `~/data/screenshots/`
- **extract**: Extracts text from page or CSS selector
- **search**: Searches DuckDuckGo, returns top 5 results with titles, URLs, snippets

## Docker

When running in Docker, Playwright needs system dependencies. Use the Playwright Docker base image or install deps:

```dockerfile
RUN npx playwright install-deps chromium
RUN npx playwright install chromium
```

## Graceful Degradation

If Playwright is not installed, the browser MCP server will not load. The kernel logs no error and continues without browser tools. Users see no disruption.
