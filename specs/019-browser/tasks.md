# Tasks: Browser Automation (Playwright)

**Task range**: T690-T699
**Parallel**: YES -- independent module. But should be scheduled AFTER 017-media voice (T668-T674) per user request.
**Deps**: After T674 (voice). Playwright is a heavy dependency (~300MB). MCP approach recommended to keep core lightweight.

## User Story

- **US-BRW1**: "The OS can browse the web for me -- search, screenshot pages, extract content, fill forms"

## Architecture

Two approaches:
1. **MCP Server** (recommended): Playwright runs as a separate MCP process. Kernel connects via `mcpServers` config. Heavyweight dependency isolated from core.
2. **Built-in tool**: Playwright added to gateway deps. Simpler but bloats core.

Recommend MCP Server approach: `packages/mcp-browser/` as a separate workspace package. Kernel discovers it via `mcpServers` in agent config. This aligns with Matrix OS extensibility philosophy (skills + MCP = plugins).

Key files:
- `packages/mcp-browser/` (new package)
- `packages/mcp-browser/src/server.ts` (MCP server with Playwright tools)
- `packages/kernel/src/spawn.ts` (add mcpServers config)
- `home/system/config.json` (browser config section)

## Tests (TDD -- write FIRST)

- [ ] T690a [P] [US-BRW1] Write `tests/mcp-browser/browser.test.ts`:
  - `navigate(url)` opens page, returns title + status
  - `screenshot(url, opts)` returns image buffer
  - `extractText(url, selector?)` returns text content
  - `search(query)` opens search engine, returns results
  - Handles timeouts, invalid URLs, connection errors
  - Browser session reuse (don't spawn new browser per request)
  - Headless mode by default

## Implementation

- [ ] T691 [US-BRW1] MCP browser server package:
  - `packages/mcp-browser/package.json` -- deps: `playwright`, `@anthropic-ai/claude-agent-sdk`
  - `packages/mcp-browser/src/server.ts` -- MCP server with tools:
    - `browse_web` -- `{ url, action: "navigate"|"screenshot"|"extract"|"search", selector?, query? }`
    - `navigate`: go to URL, return `{ title, url, status, text (first 2000 chars) }`
    - `screenshot`: capture page, save to temp file, return path
    - `extract`: extract text from selector or full page
    - `search`: search via DuckDuckGo, return top 5 results with titles + URLs + snippets
  - Launch: `node packages/mcp-browser/src/server.ts` (stdio MCP)
  - Browser lifecycle: lazy-start on first request, reuse across calls, close on server shutdown

- [ ] T692 [US-BRW1] Browser configuration:
  - `home/system/config.json` -> `"browser": { "enabled": true, "headless": true, "timeout": 30000 }`
  - `packages/kernel/src/spawn.ts`: add MCP server config when browser enabled:
    ```
    mcpServers: [{ name: "browser", command: "node", args: ["packages/mcp-browser/src/server.ts"] }]
    ```

- [ ] T693 [US-BRW1] Playwright installation:
  - `pnpm --filter mcp-browser exec playwright install chromium` (only chromium, not all browsers)
  - Document in README/setup: browser automation requires explicit Playwright install
  - Docker: include Playwright deps in Dockerfile when browser enabled

- [ ] T694 [US-BRW1] Screenshot serving:
  - Screenshots saved to `~/data/screenshots/` (Everything Is a File)
  - Already served via `/files/data/screenshots/*`
  - Shell: detect screenshot paths in responses, render inline (same as T667 image rendering)

- [ ] T695 [US-BRW1] Builder agent integration:
  - Update `home/agents/custom/builder.md` to mention browser capability
  - Builder can browse reference sites for design inspiration
  - "Look at stripe.com and build something similar" workflow

## Implications

- **Playwright size**: ~300MB for Chromium. MCP approach means it's only installed when user enables browser.
- **Docker**: Browser in Docker needs extra deps (`libnss3`, `libatk-bridge2.0-0`, etc.). Playwright provides a Docker base image. Consider optional layer or multi-stage build.
- **Security**: Browser automation can access any URL. Approval gate (T632) should require approval for `browse_web` tool by default.
- **MCP vs built-in**: MCP approach means Playwright is a separate process. Kernel communicates via stdio. This is the Agent SDK way (mcpServers config).
- **Cost tracking**: Browser automation should track usage (T662 usage tracker, action: "browser"). No direct API cost, but resource usage.
- **Future**: form filling, login flows, scraping pipelines, browser-based testing of generated apps.

## Checkpoint

- [ ] "Search the web for Matrix protocol documentation" -- kernel searches, returns results.
- [ ] "Take a screenshot of matrix-os.com" -- screenshot saved and displayed in chat.
- [ ] "Extract the main text from this URL" -- text extracted and returned.
- [ ] Browser disabled when Playwright not installed -- graceful error.
- [ ] `bun run test` passes (browser tests use mocked Playwright).
