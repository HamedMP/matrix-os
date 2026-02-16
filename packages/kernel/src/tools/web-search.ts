import { WebCache } from "./web-cache.js";

export type SearchProvider = "brave" | "perplexity" | "grok";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  age?: string;
}

export interface WebSearchResult {
  query: string;
  provider: SearchProvider;
  results: SearchResult[];
  answer?: string;
}

export interface WebSearchInput {
  query: string;
  count?: number;
  provider?: SearchProvider;
  freshness?: "day" | "week" | "month" | "year";
}

interface FetchLike {
  (url: string, init?: RequestInit): Promise<{ ok: boolean; status?: number; statusText?: string; json(): Promise<unknown> }>;
}

export interface ApiKeys {
  brave?: string;
  perplexity?: string;
  grok?: string;
}

export interface WebSearchToolOptions {
  cache: WebCache;
  fetcher?: FetchLike;
  apiKeys: ApiKeys;
}

const FRESHNESS_MAP: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

const PROVIDER_PRIORITY: SearchProvider[] = ["brave", "perplexity", "grok"];

function detectProvider(apiKeys: ApiKeys, requested?: SearchProvider): SearchProvider {
  if (requested) {
    const key = apiKeys[requested];
    if (!key) throw new Error(`No API key configured for ${requested}. Set the appropriate environment variable.`);
    return requested;
  }
  for (const p of PROVIDER_PRIORITY) {
    if (apiKeys[p]) return p;
  }
  throw new Error("No search API key configured. Set BRAVE_API_KEY, PERPLEXITY_API_KEY, or XAI_API_KEY.");
}

export function createWebSearchTool(opts: WebSearchToolOptions) {
  const {
    cache,
    fetcher = globalThis.fetch as unknown as FetchLike,
    apiKeys,
  } = opts;

  async function execute(input: WebSearchInput): Promise<WebSearchResult> {
    const { query, count = 5, freshness } = input;
    const provider = detectProvider(apiKeys, input.provider);

    const cacheKey = `search:${provider}:${query}:${count}:${freshness ?? ""}`;
    const cached = cache.get<WebSearchResult>(cacheKey);
    if (cached) return cached;

    let result: WebSearchResult;

    switch (provider) {
      case "brave":
        result = await searchBrave(query, count, freshness, apiKeys.brave!, fetcher);
        break;
      case "perplexity":
        result = await searchPerplexity(query, count, freshness, apiKeys.perplexity!, fetcher);
        break;
      case "grok":
        result = await searchGrok(query, apiKeys.grok!, fetcher);
        break;
    }

    cache.set(cacheKey, result);
    return result;
  }

  return { execute };
}

async function searchBrave(
  query: string,
  count: number,
  freshness: string | undefined,
  apiKey: string,
  fetcher: FetchLike,
): Promise<WebSearchResult> {
  const params = new URLSearchParams({
    q: query,
    count: String(count),
  });
  if (freshness && FRESHNESS_MAP[freshness]) {
    params.set("freshness", FRESHNESS_MAP[freshness]);
  }

  const url = `https://api.search.brave.com/res/v1/web/search?${params}`;
  const response = await fetcher(url, {
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { web?: { results?: Array<{ title: string; url: string; description: string; age?: string }> } };
  const results: SearchResult[] = (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
    age: r.age,
  }));

  return { query, provider: "brave", results };
}

async function searchPerplexity(
  query: string,
  count: number,
  freshness: string | undefined,
  apiKey: string,
  fetcher: FetchLike,
): Promise<WebSearchResult> {
  const isOpenRouter = apiKey.startsWith("sk-or-");
  const endpoint = isOpenRouter
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://api.perplexity.ai/chat/completions";

  const model = isOpenRouter ? "perplexity/sonar-pro" : "sonar-pro";

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: query }],
    max_tokens: 1024,
  };

  if (freshness) {
    body.search_recency_filter = freshness;
  }

  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Perplexity API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    citations?: string[];
  };

  const answer = data.choices?.[0]?.message?.content ?? "";
  const citations = data.citations ?? [];

  return {
    query,
    provider: "perplexity",
    results: citations.map((c, i) => ({
      title: `Citation ${i + 1}`,
      url: c,
      snippet: "",
    })),
    answer,
  };
}

async function searchGrok(
  query: string,
  apiKey: string,
  fetcher: FetchLike,
): Promise<WebSearchResult> {
  const response = await fetcher("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-3",
      messages: [{ role: "user", content: query }],
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    throw new Error(`Grok API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const answer = data.choices?.[0]?.message?.content ?? "";

  return {
    query,
    provider: "grok",
    results: [],
    answer,
  };
}
