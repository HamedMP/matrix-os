# Tasks: Web Tools -- Fetch + Search

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T850-T869

## User Stories

- **US36**: "My AI can search the web and give me current information"
- **US37**: "My AI can read any web page and summarize it for me"
- **US38**: "Web content is cached so repeated lookups are fast"

---

## Phase A: Cache + Fetch (T850-T856)

### Tests (TDD -- write FIRST)

- [ ] T850a [US38] Write `tests/web-tools/web-cache.test.ts`:
  - set() stores entry, get() retrieves it
  - Entries expire after TTL
  - clear() removes all entries
  - size() returns correct count
  - Expired entries not returned by get()

- [ ] T851a [US37] Write `tests/web-tools/web-fetch.test.ts`:
  - Fetches URL and returns content
  - Cloudflare markdown path: returns markdown when server sends text/markdown
  - Readability path: extracts article from HTML
  - Firecrawl path: falls back when readability returns empty (mocked)
  - Respects maxChars truncation
  - Returns extractedVia indicator
  - Invalid URL throws validation error
  - Cache hit returns cached content without re-fetching
  - SSRF-blocked URLs throw SsrfBlockedError (when wired)
  - Content wrapped with external content markers (when wired)

### T850 [US38] WebCache
- [ ] Create `packages/kernel/src/tools/web-cache.ts`
- [ ] In-memory Map with TTL per entry
- [ ] Auto-eviction: lazy on get() + periodic sweep
- [ ] Cache key normalization (URL: strip trailing slash, sort query params)
- [ ] Configurable default TTL (default: 15 minutes)
- **Output**: Shared cache for web fetch and search

### T851 [US37] Web fetch tool -- core
- [ ] Create `packages/kernel/src/tools/web-fetch.ts`
- [ ] `createWebFetchTool()` returns MCP tool definition
- [ ] Input: `{ url, extractMode?, maxChars? }`
- [ ] URL validation (must be http/https, no data: or file: URIs)
- [ ] Cache check before fetch
- [ ] Output: `{ url, title, content, extractedVia, charCount }`
- **Output**: web_fetch tool skeleton with cache integration

### T852 [US37] Cloudflare Markdown for Agents
- [ ] Send `Accept: text/markdown` header on fetch
- [ ] If response `Content-Type` is `text/markdown`, use body directly
- [ ] Log `x-markdown-tokens` header for token budget debugging
- [ ] No external dependency, pure fetch
- **Output**: Tier 1 extraction (zero cost, best quality when available)

### T853 [US37] Readability extraction
- [ ] Create `packages/kernel/src/tools/web-utils.ts`
- [ ] Parse HTML with `linkedom` (lightweight, no browser)
- [ ] Extract article with `@mozilla/readability`
- [ ] Convert to markdown with `turndown` (or return plain text based on extractMode)
- [ ] Strip nav, ads, sidebars, footers automatically
- **Output**: Tier 2 extraction (local, no API key, works on most sites)

### T854 [P] [US37] Firecrawl fallback
- [ ] If readability returns empty/no content AND `FIRECRAWL_API_KEY` is set, try Firecrawl
- [ ] POST `https://api.firecrawl.dev/v1/scrape` with `{ url, formats: ["markdown"] }`
- [ ] Firecrawl handles JavaScript-rendered pages (SPAs, dynamic content)
- [ ] Opt-in: gracefully skip if no API key configured
- **Output**: Tier 3 extraction (paid, handles JS-heavy sites)

### T855 [US37] Register web_fetch on IPC server
- [ ] Add `web_fetch` tool to `packages/kernel/src/ipc-server.ts`
- [ ] Zod schema for input validation
- [ ] Tool description for LLM: "Fetch and extract content from a web page URL"
- **Output**: Agent can use web_fetch tool

### T856 [P] Content truncation and budget
- [ ] Truncate extracted content to maxChars (default: 50,000)
- [ ] Deduct wrapper overhead from content budget before truncation
- [ ] Hard cap from config: `tools.web.fetch.maxCharsCap`
- **Output**: Content fits within token budgets

---

## Phase B: Search (T857-T860)

### Tests (TDD -- write FIRST)

- [ ] T857a [US36] Write `tests/web-tools/web-search.test.ts`:
  - Brave: returns structured results (title, url, snippet)
  - Perplexity: returns conversational answer with citations
  - Grok: returns structured answer
  - Auto-detects provider from available API keys
  - Freshness parameter maps correctly per provider
  - Missing API key returns helpful error (not crash)
  - Cache hit returns cached results
  - Count parameter limits results

### T857 [US36] Brave Search provider
- [ ] Endpoint: `https://api.search.brave.com/res/v1/web/search`
- [ ] Auth: `X-Subscription-Token` header with API key
- [ ] Parse response into SearchResult[] (title, url, snippet, age)
- [ ] Freshness mapping: day -> `pd`, week -> `pw`, month -> `pm`, year -> `py`
- [ ] Country/language filtering support
- **Output**: Brave search provider

### T858 [US36] Perplexity provider
- [ ] Auto-detect endpoint from key prefix: `sk-or-` -> OpenRouter, `pplx-` -> direct
- [ ] OpenRouter: `https://openrouter.ai/api/v1/chat/completions`
- [ ] Direct: `https://api.perplexity.ai/chat/completions`
- [ ] Model: `perplexity/sonar-pro` (conversational search)
- [ ] Returns answer string with inline citations
- [ ] Freshness: mapped to `search_recency_filter`
- **Output**: Perplexity search provider (conversational)

### T859 [P] [US36] Grok/xAI provider
- [ ] Endpoint: `https://api.x.ai/v1/chat/completions`
- [ ] Model: `grok-3` (or latest)
- [ ] Auth: `Authorization: Bearer` with XAI_API_KEY
- [ ] Returns structured answer with web grounding
- **Output**: Grok search provider (real-time)

### T860 [US36] Register web_search on IPC server
- [ ] Add `web_search` tool to `packages/kernel/src/ipc-server.ts`
- [ ] Auto-detect provider from available API keys (priority: brave > perplexity > grok)
- [ ] Allow explicit provider override in input
- [ ] Zod schema: `{ query, count?, provider?, freshness? }`
- [ ] Tool description: "Search the web for current information"
- **Output**: Agent can use web_search tool

---

## Phase C: Integration (T861-T864)

### T861 [US37] Wire SSRF guard
- [ ] All outbound HTTP in web_fetch goes through `fetchWithSsrfGuard()` (from 025 T825)
- [ ] If SSRF guard not yet built, use plain fetch with TODO marker
- **Output**: Web fetch protected against SSRF

### T862 [US37] Wire external content wrapping
- [ ] web_fetch results wrapped with `wrapExternalContent({ source: "web_fetch" })` -- includes warning
- [ ] web_search results wrapped with `wrapExternalContent({ source: "web_search" })` -- no warning
- [ ] If content wrapping not yet built (025 T820), use identity function with TODO
- **Output**: Web content defensively wrapped

### T863 Config section
- [ ] Add `tools.web` section to `home/system/config.json` template
- [ ] Search: provider, API keys as ${VAR} refs
- [ ] Fetch: maxChars, cacheTtlMinutes, firecrawlApiKey as ${VAR} ref
- **Output**: Web tools configurable via Everything Is a File

### T864 [P] System prompt update
- [ ] Update prompt builder to mention web_fetch and web_search capabilities
- [ ] Only mention if at least one search provider is configured
- [ ] Brief: "You can search the web and fetch web pages. Use web_search for current info, web_fetch for reading specific pages."
- **Output**: Agent knows it has web capabilities

---

## Checkpoint

1. "Search for Matrix protocol latest news" -- agent uses web_search, returns current results.
2. "Read this page: https://matrix.org/docs/" -- agent uses web_fetch, extracts content.
3. Second fetch of same URL is instant (cache hit, no network request).
4. Fetch of `http://192.168.1.1/admin` -- blocked by SSRF guard.
5. Content from web_fetch is wrapped in external content markers.
6. No API keys configured -- search returns helpful "configure API key" message.
7. `bun run test` passes.
