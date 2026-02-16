# Plan: Web Tools -- Fetch + Search

**Spec**: `specs/026-web-tools/spec.md`
**Depends on**: 025-security T820 (content wrapping), T825 (SSRF guard) -- can stub if not ready
**Estimated effort**: Medium (10 tasks + TDD)

## Approach

Build web_fetch first since it's the more complex tool (three-tier extraction). Then web_search (simpler, API calls). Cache is shared infrastructure built first. All results are wrapped for security before returning to the agent.

### Phase A: Cache + Fetch (T850-T856)

1. WebCache -- in-memory Map with TTL, auto-eviction
2. web_fetch tool -- URL validation, cache check, extraction waterfall
3. Cloudflare Markdown for Agents -- `Accept: text/markdown` header, content-type detection
4. Readability extraction -- `@mozilla/readability` + `linkedom` + `turndown`
5. Firecrawl fallback -- opt-in, API key required
6. Register on IPC server

### Phase B: Search (T857-T860)

1. Brave Search provider -- REST API, result parsing
2. Perplexity provider -- OpenRouter/direct, conversational answer with citations
3. Grok provider -- xAI responses API
4. Auto-detect provider from available API keys
5. Register on IPC server

### Phase C: Integration (T861-T864)

1. Wire SSRF guard into fetch pipeline
2. Wire external content wrapping into results
3. Config section in config.json
4. Update system prompt to advertise web capabilities

## Files to Create

- `packages/kernel/src/tools/web-cache.ts`
- `packages/kernel/src/tools/web-fetch.ts`
- `packages/kernel/src/tools/web-search.ts`
- `packages/kernel/src/tools/web-utils.ts`
- `tests/web-tools/web-fetch.test.ts`
- `tests/web-tools/web-search.test.ts`
- `tests/web-tools/web-cache.test.ts`

## Files to Modify

- `packages/kernel/src/ipc-server.ts` -- register web_fetch + web_search tools
- `packages/kernel/src/prompt.ts` -- advertise web tools in system prompt
- `packages/kernel/package.json` -- add deps: `@mozilla/readability`, `linkedom`, `turndown`
- `home/system/config.json` -- tools.web section

## New Dependencies

- `@mozilla/readability` -- article extraction (ISC license, Mozilla)
- `linkedom` -- lightweight DOM for readability (ISC license)
- `turndown` -- HTML to markdown (MIT license)
- No new deps for search providers (plain fetch + JSON)
