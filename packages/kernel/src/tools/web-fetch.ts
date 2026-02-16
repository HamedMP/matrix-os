import { WebCache } from "./web-cache.js";
import { extractWithReadability, extractRawText } from "./web-utils.js";
import { wrapExternalContent } from "../security/external-content.js";
import { validateUrl, SsrfBlockedError } from "../security/ssrf-guard.js";

export type ExtractMode = "markdown" | "text";
export type ExtractedVia = "cloudflare-markdown" | "readability" | "firecrawl" | "raw";

export interface WebFetchInput {
  url: string;
  extractMode?: ExtractMode;
  maxChars?: number;
}

export interface WebFetchResult {
  url: string;
  title?: string;
  content: string;
  extractedVia: ExtractedVia;
  charCount: number;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  headers: Map<string, string>;
  text(): Promise<string>;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<FetchResponse>;

export interface WebFetchToolOptions {
  cache: WebCache;
  fetcher?: Fetcher;
  wrapContent?: boolean;
  maxChars?: number;
  firecrawlApiKey?: string;
}

const DEFAULT_MAX_CHARS = 50_000;

function validateWebUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Blocked URL scheme: ${parsed.protocol} (only http/https allowed)`);
  }
}

export function createWebFetchTool(opts: WebFetchToolOptions) {
  const {
    cache,
    fetcher = globalThis.fetch as unknown as Fetcher,
    wrapContent = false,
    maxChars: defaultMaxChars = DEFAULT_MAX_CHARS,
    firecrawlApiKey,
  } = opts;

  async function execute(input: WebFetchInput): Promise<WebFetchResult> {
    const { url, extractMode = "markdown", maxChars = defaultMaxChars } = input;

    validateWebUrl(url);
    await validateUrl(url);

    const cacheKey = `fetch:${WebCache.normalizeUrl(url)}`;
    const cached = cache.get<WebFetchResult>(cacheKey);
    if (cached) return cached;

    const response = await fetcher(url, {
      headers: {
        Accept: "text/markdown, text/html;q=0.9, */*;q=0.8",
        "User-Agent": "MatrixOS/1.0 (web-fetch)",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${url}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();

    let content: string;
    let title: string | undefined;
    let extractedVia: ExtractedVia;

    if (contentType.includes("text/markdown")) {
      content = body;
      extractedVia = "cloudflare-markdown";
    } else {
      const article = await extractWithReadability(body, url).catch(() => null);
      if (article && article.content.trim()) {
        content = extractMode === "text" ? article.textContent : article.content;
        title = article.title;
        extractedVia = "readability";
      } else if (firecrawlApiKey) {
        const fcResult = await fetchWithFirecrawl(url, firecrawlApiKey, fetcher);
        if (fcResult) {
          content = fcResult.content;
          title = fcResult.title;
          extractedVia = "firecrawl";
        } else {
          content = extractRawText(body);
          extractedVia = "raw";
        }
      } else {
        content = extractRawText(body);
        extractedVia = "raw";
      }
    }

    if (content.length > maxChars) {
      content = content.slice(0, maxChars);
    }

    if (wrapContent) {
      content = wrapExternalContent(content, {
        source: "web_fetch",
        subject: title ?? url,
      });
    }

    const result: WebFetchResult = {
      url,
      title,
      content,
      extractedVia,
      charCount: content.length,
    };

    cache.set(cacheKey, result);
    return result;
  }

  return { execute };
}

async function fetchWithFirecrawl(
  url: string,
  apiKey: string,
  fetcher: Fetcher,
): Promise<{ content: string; title?: string } | null> {
  try {
    const response = await fetcher("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });
    if (!response.ok) return null;
    const data = JSON.parse(await response.text()) as {
      data?: { markdown?: string; metadata?: { title?: string } };
    };
    if (!data.data?.markdown) return null;
    return {
      content: data.data.markdown,
      title: data.data.metadata?.title,
    };
  } catch {
    return null;
  }
}
