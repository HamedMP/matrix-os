"use client";

export const MARKETING_ATTRIBUTION_KEYS = [
  "rdt_cid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

export type MarketingAttribution = Partial<Record<(typeof MARKETING_ATTRIBUTION_KEYS)[number], string>> & {
  landing_path?: string;
};

const STORAGE_KEY = "matrix_marketing_attribution_v1";
const MAX_VALUE_LENGTH = 256;
const MAX_PATH_LENGTH = 512;

function clean(value: string | null | undefined, maxLength = MAX_VALUE_LENGTH): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function readStored(): MarketingAttribution {
  if (typeof window === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const source = parsed as Record<string, unknown>;
    const attribution: MarketingAttribution = {};
    for (const key of MARKETING_ATTRIBUTION_KEYS) {
      const value = clean(typeof source[key] === "string" ? source[key] : undefined);
      if (value) attribution[key] = value;
    }
    const landingPath = clean(
      typeof source.landing_path === "string" ? source.landing_path : undefined,
      MAX_PATH_LENGTH,
    );
    if (landingPath) attribution.landing_path = landingPath;
    return attribution;
  } catch (err: unknown) {
    console.warn("[attribution] Failed to read campaign data:", err instanceof Error ? err.name : typeof err);
    return {};
  }
}

export function captureMarketingAttribution(): MarketingAttribution {
  if (typeof window === "undefined") return {};
  const url = new URL(window.location.href);
  const incoming: MarketingAttribution = {};
  for (const key of MARKETING_ATTRIBUTION_KEYS) {
    const value = clean(url.searchParams.get(key));
    if (value) incoming[key] = value;
  }
  const hasIncomingCampaign = MARKETING_ATTRIBUTION_KEYS.some((key) => incoming[key]);
  const allowedQuery = new URLSearchParams();
  for (const key of MARKETING_ATTRIBUTION_KEYS) {
    if (incoming[key]) allowedQuery.set(key, incoming[key]!);
  }
  const landingPath = allowedQuery.size > 0
    ? `${url.pathname}?${allowedQuery.toString()}`.slice(0, MAX_PATH_LENGTH)
    : undefined;
  const attribution: MarketingAttribution = {
    ...readStored(),
    ...incoming,
    ...(hasIncomingCampaign && landingPath ? { landing_path: landingPath } : {}),
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(attribution));
  } catch (err: unknown) {
    console.warn("[attribution] Failed to store campaign data:", err instanceof Error ? err.name : typeof err);
  }
  return attribution;
}

export function getMarketingAttributionProperties(): Record<string, string> {
  return captureMarketingAttribution();
}

export function getCheckoutAttribution(): MarketingAttribution | undefined {
  const attribution = captureMarketingAttribution();
  return Object.keys(attribution).length > 0 ? attribution : undefined;
}
