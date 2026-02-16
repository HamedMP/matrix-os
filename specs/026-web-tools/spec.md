# 026: Web Tools -- Fetch + Search

## Problem

The kernel has no built-in ability to fetch web pages or search the internet. The agent relies entirely on pre-existing knowledge. Users asking "what's the weather" or "search for Matrix protocol docs" get stale or no results. Moltbot has a full web pipeline (Cloudflare Markdown for Agents, Readability, Firecrawl, Brave/Perplexity/Grok search) -- Matrix OS has nothing.

## Solution

Two IPC tools (`web_fetch` and `web_search`) registered on the kernel's MCP server. Web fetch uses a three-tier extraction waterfall: Cloudflare Markdown for Agents (free, best quality) > Mozilla Readability (local, no API key) > Firecrawl (paid, JavaScript-heavy sites). Web search supports three providers: Brave (free tier), Perplexity (conversational), Grok/xAI (real-time). All results go through the external content wrapping from 025-security and the SSRF guard.

## Design

### Web Fetch

```typescript
type ExtractMode = "markdown" | "text";

interface WebFetchInput {
  url: string;
  extractMode?: ExtractMode;   // default: "markdown"
  maxChars?: number;            // default: 50_000
}

interface WebFetchResult {
  url: string;
  title?: string;
  content: string;              // extracted and wrapped
  extractedVia: "cloudflare-markdown" | "readability" | "firecrawl" | "raw";
  charCount: number;
}
```

Extraction waterfall:
1. **Cloudflare Markdown for Agents**: Send `Accept: text/markdown` header. If response has `Content-Type: text/markdown`, use directly. Zero cost.
2. **Mozilla Readability**: Parse HTML with `@mozilla/readability` + `linkedom` (lightweight DOM). Extract article body, convert to markdown via `turndown`.
3. **Firecrawl** (opt-in): If readability returns empty or fetch fails, fall back to Firecrawl API. Requires `FIRECRAWL_API_KEY`. Handles JavaScript-rendered pages.

### Web Search

```typescript
type SearchProvider = "brave" | "perplexity" | "grok";

interface WebSearchInput {
  query: string;
  count?: number;           // 1-10, default: 5
  provider?: SearchProvider; // auto-detected from available API keys
  freshness?: "day" | "week" | "month" | "year";
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  age?: string;
}

interface WebSearchResult {
  query: string;
  provider: SearchProvider;
  results: SearchResult[];    // for brave/grok
  answer?: string;            // for perplexity (conversational)
}
```

Provider config via `~/system/config.json`:
```json
{
  "tools": {
    "web": {
      "search": {
        "provider": "brave",
        "braveApiKey": "${BRAVE_API_KEY}",
        "perplexityApiKey": "${PERPLEXITY_API_KEY}",
        "grokApiKey": "${XAI_API_KEY}"
      },
      "fetch": {
        "maxChars": 50000,
        "cacheTtlMinutes": 15,
        "firecrawlApiKey": "${FIRECRAWL_API_KEY}"
      }
    }
  }
}
```

### Cache

In-memory cache with configurable TTL. Shared between web_fetch and web_search. Cache key = normalized URL or query + provider + options hash.

```typescript
class WebCache {
  get(key: string): CacheEntry | undefined;
  set(key: string, value: unknown, ttlMs?: number): void;
  clear(): void;
  size(): number;
}
```

### Integration with Security (025)

- All outbound HTTP through `fetchWithSsrfGuard()` (T825)
- All results wrapped with `wrapExternalContent()` (T820)
- web_search results: no warning prefix (trusted search API)
- web_fetch results: warning prefix (arbitrary web content)

## Dependencies

- Phase 025 T820 (external content wrapping) -- should ship first but can stub
- Phase 025 T825 (SSRF guard) -- should ship first but can stub

## File Locations

```
packages/kernel/src/
  tools/
    web-fetch.ts          # createWebFetchTool, extraction waterfall
    web-search.ts         # createWebSearchTool, provider dispatch
    web-cache.ts          # WebCache (in-memory, TTL)
    web-utils.ts          # readability extraction, markdown conversion
packages/kernel/src/
  ipc-server.ts           # register web_fetch + web_search tools
tests/
  web-tools/
    web-fetch.test.ts
    web-search.test.ts
    web-cache.test.ts
```
