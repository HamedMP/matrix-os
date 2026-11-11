import { createHash } from "node:crypto";
import { FUNDED_PRICING_CATALOG } from "@matrix-os/contracts";
import { readFundedPricingReviewText } from "./funded-pricing-review-job-http.js";

export const FUNDED_PRICING_SOURCE_URLS = {
  workers: "https://developers.cloudflare.com/workers-ai/platform/pricing/index.md",
  changelog: "https://developers.cloudflare.com/changelog/product/workers-ai/index.md",
  sonnet: "https://developers.cloudflare.com/ai/models/anthropic/claude-sonnet-5/index.md",
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing.md",
  anthropicLifecycle: "https://platform.claude.com/docs/en/about-claude/model-deprecations.md",
} as const;

const SONNET = "anthropic/claude-sonnet-5";
const MAX_SOURCE_BYTES = 512 * 1024;
const SOURCE_TIMEOUT_MS = 8_000;
type ExpectedRates = (typeof FUNDED_PRICING_CATALOG)[string];
type Rates = { input: number; output: number; cached?: number };
type FullRates = Required<Rates> & { cacheWrite5m: number; cacheWrite1h: number };

export interface OfficialPricingObservation {
  kind: "match" | "changed" | "inconclusive";
  retiredAt: string | null;
  sourceDigest: string | null;
  sourceUrl: string;
  retirementSourceUrl?: string;
}

function thousandths(dollars: string): number | null {
  const match = /^(\d{1,5})(?:\.(\d{1,3}))?$/.exec(dollars);
  if (!match) return null;
  return Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
}

function tableRows(text: string, label: string): string[][] {
  return text.split(/\r?\n/).filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((part) => part.trim()))
    .filter((cells) => cells[0] === label);
}

function uniqueCell(text: string, label: string): string | null {
  const rows = tableRows(text, label);
  return rows.length === 1 ? rows[0]?.[1] ?? null : null;
}

function workersRates(value: string | null): Rates | null {
  if (!value) return null;
  const rates: Partial<Rates> = {};
  for (const part of value.split(/\s*(?:<br\s*\/?>|,)\s*/i)) {
    const match = /^\$(\d{1,5}(?:\.\d{1,3})?) per M (input|output|cached input) tokens$/.exec(part);
    if (!match) return null;
    const key = match[2] === "cached input" ? "cached" : match[2] as "input" | "output";
    const rate = thousandths(match[1]!);
    if (rates[key] !== undefined || rate === null) return null;
    rates[key] = rate;
  }
  if (rates.input === undefined || rates.output === undefined) return null;
  return { input: rates.input, output: rates.output, cached: rates.cached };
}

function modelPageMatches(text: string, modelId: string): boolean {
  const ids = [...text.matchAll(/^Model ID\r?\n\s*`([@a-z0-9/._-]+)` Copy\s*$/gm)];
  return ids.length === 1 && ids[0]?.[1] === modelId;
}

function cloudflareSonnet(text: string): Omit<FullRates, "cacheWrite1h"> | null {
  if (!modelPageMatches(text, SONNET)) return null;
  const value = uniqueCell(text, "Pricing");
  if (!value?.startsWith("<ul>") || !value.endsWith("</ul>")) return null;
  const rates: Partial<FullRates> = {};
  const labels = { Input: "input", Output: "output", "Cached input": "cached", "Cache creation": "cacheWrite5m" } as const;
  const items = [...value.matchAll(/<li>([^<]+)<\/li>/g)];
  if (items.map((item) => item[0]).join("") !== value.slice(4, -5)) return null;
  for (const item of items) {
    const match = /^(Input|Output|Cached input|Cache creation) \(per 1M tokens\)\$(\d{1,5}(?:\.\d{1,3})?)$/.exec(item[1]!);
    if (!match) return null;
    const key = labels[match[1] as keyof typeof labels];
    const rate = thousandths(match[2]!);
    if (rates[key] !== undefined || rate === null) return null;
    rates[key] = rate;
  }
  const { input, output, cached, cacheWrite5m } = rates;
  if (input === undefined || output === undefined || cached === undefined || cacheWrite5m === undefined) return null;
  return { input, output, cached, cacheWrite5m };
}

function anthropicSonnet(text: string): FullRates | null {
  const headings = text.split(/\r?\n/);
  const start = headings.findIndex((line) => line.startsWith("| Model") &&
    /\| Base input tokens\s+\| 5m cache writes\s+\| 1h cache writes\s+\| Cache hits and refreshes\s+\| Output tokens\s+\|/.test(line));
  if (start === -1) return null;
  const afterHeader = headings.slice(start + 1);
  const end = afterHeader.findIndex((line) => !line.startsWith("|"));
  const rows = tableRows(afterHeader.slice(0, end === -1 ? undefined : end).join("\n"), "Claude Sonnet 5");
  if (rows.length !== 1 || rows[0]?.length !== 6) return null;
  const [input, cacheWrite5m, cacheWrite1h, cached, output] = rows[0].slice(1).map((cell) => {
    const match = /^\$(\d{1,5}(?:\.\d{1,3})?) \/ MTok(?:<sup>\d+<\/sup>)?$/.exec(cell);
    return match ? thousandths(match[1]!) : null;
  });
  if (input == null || cacheWrite5m == null || cacheWrite1h == null || cached == null || output == null) return null;
  return { input, cacheWrite5m, cacheWrite1h, cached, output };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function utcDay(month: string, day: string, year: string): string | null {
  const monthIndex = MONTHS.indexOf(month);
  if (monthIndex < 0 || Number(year) < 2020) return null;
  const date = new Date(Date.UTC(Number(year), monthIndex, Number(day)));
  return date.getUTCMonth() === monthIndex && date.getUTCDate() === Number(day) ? date.toISOString() : null;
}

/** Match published calendar-day sections and exact IDs. Advisory prose is not an effective date. */
function retirements(text: string, catalog: Readonly<Record<string, ExpectedRates>>): Record<string, string> | null {
  if (!/^# (?:Workers AI )?Changelog\s*$/im.test(text) && !/^---\r?\ntitle: Workers AI Changelog\r?\n/.test(text)) return null;
  const result: Record<string, string> = {};
  let date: string | null = null;
  let sawModel = false;
  let needsList = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\[<h2>|^##\s/.test(line)) {
      if (needsList || (date && !sawModel)) return null;
      needsList = /^\[<h2>Planned model deprecations on Workers AI<\/h2>\]/i.test(line);
      date = null;
    }
    if (/^#### Models deprecated on\b/.test(line)) {
      if (date && !sawModel) return null;
      const parsed = /^#### Models deprecated on ([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(line);
      if (!parsed) return null;
      date = utcDay(parsed[1]!, parsed[2]!, parsed[3]!);
      if (!date) return null;
      needsList = false;
      sawModel = false;
      continue;
    }
    if (/^####\s/.test(line) && !/^#### (?:LLMs|Other models)\s*$/.test(line)) {
      if (date && !sawModel) return null;
      date = null;
    }
    if (!date) continue;
    const model = /^[-*] (?:\[)?`(@(?:cf|hf)\/[a-z0-9_.-]+\/[a-z0-9_.-]+)`/.exec(line)?.[1];
    if (!model) continue;
    sawModel = true;
    if (Object.hasOwn(catalog, model) && (!result[model] || date < result[model])) result[model] = date;
  }
  return needsList || (date && !sawModel) ? null : result;
}

function sonnetLifecycle(text: string): { retiredAt: string | null } | null {
  const sections = text.split(/^## /m);
  const status = sections.find((section) => section.startsWith("Model status"));
  if (!status || !/^\| API model name\s+\| Current state\s+\| Deprecated\s+\| Tentative retirement date\s+\|$/m.test(status)) {
    return null;
  }
  const rows = tableRows(status, "claude-sonnet-5");
  if (rows.length !== 1 || rows[0]?.length !== 4) return null;
  const [, state, deprecated, date] = rows[0];
  if (state === "Active" && deprecated === "N/A") return { retiredAt: null };
  if (state !== "Deprecated" && state !== "Retired") return null;
  const parsed = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(date ?? "");
  const retiredAt = parsed ? utcDay(parsed[1]!, parsed[2]!, parsed[3]!) : null;
  return retiredAt ? { retiredAt } : null;
}

function matchBaseRates(left: Rates, right: Rates): boolean {
  return left.input === right.input && left.output === right.output;
}

async function getOfficialText(url: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetchFn(url, {
      headers: { accept: "text/markdown, text/plain" },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(SOURCE_TIMEOUT_MS)]),
    });
    return await readFundedPricingReviewText(response, MAX_SOURCE_BYTES);
  } catch (error) {
    signal.throwIfAborted();
    console.warn("[funded-ai] pricing evidence unavailable", new URL(url).hostname, error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

function evidenceDigest(...sources: (string | null)[]): string {
  return createHash("sha256").update(JSON.stringify(sources)).digest("hex");
}

function assessSonnet(
  expected: ExpectedRates, cloudflare: string | null, anthropic: string | null, lifecycle: string | null,
): OfficialPricingObservation {
  const cfRates = cloudflare ? cloudflareSonnet(cloudflare) : null;
  const vendorRates = anthropic ? anthropicSonnet(anthropic) : null;
  const status = lifecycle ? sonnetLifecycle(lifecycle) : null;
  const retiredAt = status?.retiredAt ?? null;
  const cloudflareChanged = cfRates !== null && (!matchBaseRates(cfRates, expected)
    || cfRates.cached !== expected.cached || cfRates.cacheWrite5m !== expected.cacheWrite5m);
  const consistent = cfRates !== null && vendorRates !== null && matchBaseRates(cfRates, vendorRates)
    && cfRates.cached === vendorRates.cached && cfRates.cacheWrite5m === vendorRates.cacheWrite5m;
  const changed = cloudflareChanged || (consistent && vendorRates.cacheWrite1h !== expected.cacheWrite1h);
  const kind = changed ? "changed" : consistent && status ? "match" : "inconclusive";
  return {
    kind,
    retiredAt,
    sourceDigest: kind !== "inconclusive" || retiredAt ? evidenceDigest(cloudflare, anthropic, lifecycle) : null,
    sourceUrl: FUNDED_PRICING_SOURCE_URLS.sonnet,
    ...(retiredAt ? { retirementSourceUrl: FUNDED_PRICING_SOURCE_URLS.anthropicLifecycle } : {}),
  };
}

async function assessWorkers(options: {
  modelId: string;
  expected: ExpectedRates;
  catalog: string | null;
  changelog: string | null;
  retiredAt: string | null;
  retirementsAvailable: boolean;
  fetchFn: typeof fetch;
  signal: AbortSignal;
}): Promise<OfficialPricingObservation> {
  const { modelId, expected, catalog, changelog, retiredAt, retirementsAvailable, fetchFn, signal } = options;
  const catalogRates = catalog ? workersRates(uniqueCell(catalog, modelId)) : null;
  const slug = /^@cf\/[a-z0-9.-]+\/([a-z0-9.-]+)$/.exec(modelId)?.[1];
  const modelPageUrl = slug ? `https://developers.cloudflare.com/workers-ai/models/${slug}/index.md` : null;
  const modelPage = catalogRates && catalogRates.cached === undefined && modelPageUrl
    ? await getOfficialText(modelPageUrl, fetchFn, signal) : null;
  const modelRates = modelPage && modelPageMatches(modelPage, modelId) ? workersRates(uniqueCell(modelPage, "Unit Pricing")) : null;
  const consistent = !modelRates || (catalogRates !== null && matchBaseRates(catalogRates, modelRates));
  const cached = catalogRates?.cached ?? modelRates?.cached;
  const changed = consistent && catalogRates !== null && (!matchBaseRates(catalogRates, expected)
    || (cached !== undefined && cached !== expected.cached));
  const fullMatch = consistent && catalogRates !== null && matchBaseRates(catalogRates, expected)
    && cached === expected.cached && expected.cacheWrite5m === expected.input && expected.cacheWrite1h === expected.input;
  const kind = changed ? "changed" : fullMatch && retirementsAvailable ? "match" : "inconclusive";
  return {
    kind,
    retiredAt,
    sourceDigest: kind !== "inconclusive" || retiredAt ? evidenceDigest(catalog, modelPage, changelog) : null,
    sourceUrl: modelPage && modelPageUrl ? modelPageUrl : FUNDED_PRICING_SOURCE_URLS.workers,
    ...(retiredAt ? { retirementSourceUrl: FUNDED_PRICING_SOURCE_URLS.changelog } : {}),
  };
}

export async function readOfficialFundedPricing(options: {
  fetchFn?: typeof fetch;
  signal: AbortSignal;
  catalog?: Readonly<Record<string, ExpectedRates>>;
}): Promise<Readonly<Record<string, OfficialPricingObservation>>> {
  const { signal, catalog = FUNDED_PRICING_CATALOG, fetchFn = fetch } = options;
  const workers = Object.keys(catalog).some((model) => model.startsWith("@cf/"));
  const sonnet = Object.hasOwn(catalog, SONNET);
  const [workersPricing, changelog, sonnetPricing, anthropicPricing, anthropicLifecycle] = await Promise.all([
    workers ? getOfficialText(FUNDED_PRICING_SOURCE_URLS.workers, fetchFn, signal) : null,
    workers ? getOfficialText(FUNDED_PRICING_SOURCE_URLS.changelog, fetchFn, signal) : null,
    sonnet ? getOfficialText(FUNDED_PRICING_SOURCE_URLS.sonnet, fetchFn, signal) : null,
    sonnet ? getOfficialText(FUNDED_PRICING_SOURCE_URLS.anthropic, fetchFn, signal) : null,
    sonnet ? getOfficialText(FUNDED_PRICING_SOURCE_URLS.anthropicLifecycle, fetchFn, signal) : null,
  ]);
  const retirementDates = changelog ? retirements(changelog, catalog) : null;
  const rows = await Promise.all(Object.entries(catalog).map(async ([modelId, expected]) => {
    const result = modelId === SONNET ? assessSonnet(expected, sonnetPricing, anthropicPricing, anthropicLifecycle)
      : await assessWorkers({
        modelId, expected, catalog: workersPricing, changelog, retiredAt: retirementDates?.[modelId] ?? null,
        retirementsAvailable: retirementDates !== null, fetchFn, signal,
      });
    return [modelId, result] as const;
  }));
  return Object.fromEntries(rows);
}
