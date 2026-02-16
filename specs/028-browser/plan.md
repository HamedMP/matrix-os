# Plan: Browser Automation (Playwright)

**Spec**: `specs/028-browser/spec.md`
**Depends on**: 025-security T820 (content wrapping), T825 (SSRF guard)
**Estimated effort**: Large (15 tasks + TDD)

## Approach

Build the MCP server skeleton first, then the session manager, then the composite browser tool with actions incrementally. Role snapshot is the key differentiator -- prioritize it early since it's what makes the browser useful for AI agents. Screenshots and PDF are polish.

### Phase A: MCP Server + Session (T900-T904)

1. MCP browser server package scaffold
2. Session manager (Playwright lifecycle, lazy start, auto-close)
3. Chromium installation management
4. Wire into kernel via mcpServers config

### Phase B: Core Actions (T905-T912)

1. navigate + snapshot (accessibility tree) -- the two most important actions
2. click + type + select (form interaction)
3. screenshot + PDF
4. evaluate (JavaScript execution in page)
5. wait + scroll
6. Tabs management (list, new, close, switch)
7. Console message reading

### Phase C: Security + Integration (T913-T917)

1. URL validation (block private IPs, file://, data:)
2. External content wrapping on all browser output
3. Screenshot file management (~/data/screenshots/)
4. Agent prompt update (advertise browser capability)
5. Docker support (Playwright browser deps in Dockerfile)

## Files to Create

- `packages/mcp-browser/package.json`
- `packages/mcp-browser/tsconfig.json`
- `packages/mcp-browser/src/server.ts`
- `packages/mcp-browser/src/browser-tool.ts`
- `packages/mcp-browser/src/session-manager.ts`
- `packages/mcp-browser/src/role-snapshot.ts`
- `packages/mcp-browser/src/screenshot.ts`
- `packages/mcp-browser/src/security.ts`
- `tests/mcp-browser/*.test.ts`

## Files to Modify

- `packages/kernel/src/spawn.ts` -- add browser MCP server to mcpServers config
- `home/system/config.json` -- browser config section
- `pnpm-workspace.yaml` -- add packages/mcp-browser
- `Dockerfile` -- optional Playwright deps layer
