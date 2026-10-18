"use client";

import { readAcceptedMarketingConsent } from "./marketing-consent";

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

const STORAGE_KEY = "matrix_marketing_attribution_v2";
const MAX_AGE_MS = 30 * 86_400_000;
const MAX_VALUE_LENGTH = 256;
const MAX_PATH_LENGTH = 512;

function clean(value: string | null | undefined, maxLength = MAX_VALUE_LENGTH): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function cleanCampaignValue(key: string, value: string | null | undefined): string | undefined {
  // Click IDs are opaque identifiers: trimming/truncation would change their identity.
  if (key === "rdt_cid") return value && value.length <= MAX_VALUE_LENGTH && !/[\s\x00-\x1f\x7f]/.test(value) ? value : undefined;
  return clean(value);
}

function clearStored(): void {
  try { window.localStorage.removeItem(STORAGE_KEY); window.localStorage.removeItem("matrix_marketing_attribution_v1"); }
  catch (error: unknown) { console.warn("[attribution] Campaign cleanup unavailable:", error instanceof Error ? error.name : typeof error); }
}

function readStored(): { attribution: MarketingAttribution; capturedAt: number; expiresAt: number } | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) ?? "{}";
    if (raw.length > 8192) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const snapshot = parsed as Record<string, unknown>;
    if (typeof snapshot.capturedAt !== "number" || !Number.isSafeInteger(snapshot.capturedAt)
      || typeof snapshot.expiresAt !== "number" || !Number.isSafeInteger(snapshot.expiresAt) || snapshot.expiresAt <= Date.now()
      || snapshot.expiresAt > snapshot.capturedAt + MAX_AGE_MS
      || snapshot.capturedAt > Date.now() || Date.now() - snapshot.capturedAt >= MAX_AGE_MS
      || !snapshot.attribution || typeof snapshot.attribution !== "object" || Array.isArray(snapshot.attribution)) return undefined;
    const source = snapshot.attribution as Record<string, unknown>;
    const attribution: MarketingAttribution = {};
    for (const key of MARKETING_ATTRIBUTION_KEYS) {
      const value = cleanCampaignValue(key, typeof source[key] === "string" ? source[key] : undefined);
      if (value) attribution[key] = value;
    }
    const landingPath = clean(
      typeof source.landing_path === "string" ? source.landing_path : undefined,
      MAX_PATH_LENGTH,
    );
    if (landingPath) attribution.landing_path = landingPath;
    return { attribution, capturedAt: snapshot.capturedAt, expiresAt: snapshot.expiresAt };
  } catch (err: unknown) {
    console.warn("[attribution] Failed to read campaign data:", err instanceof Error ? err.name : typeof err);
    return undefined;
  }
}

export function captureMarketingAttribution(): MarketingAttribution {
  if (typeof window === "undefined") return {};
  try { window.localStorage.removeItem("matrix_marketing_attribution_v1"); }
  catch (error: unknown) { console.warn("[attribution] Legacy cleanup unavailable:", error instanceof Error ? error.name : typeof error); }
  const consent = readAcceptedMarketingConsent();
  if (!consent) { clearStored(); return {}; }
  const url = new URL(window.location.href);
  const incoming: MarketingAttribution = {};
  for (const key of MARKETING_ATTRIBUTION_KEYS) {
    const value = cleanCampaignValue(key, url.searchParams.get(key));
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
  const stored = readStored();
  const sameCampaign = stored && MARKETING_ATTRIBUTION_KEYS.every(key => incoming[key] === stored.attribution[key]);
  const newCampaign = hasIncomingCampaign && !sameCampaign;
  const attribution: MarketingAttribution = newCampaign
    ? {
        ...incoming,
        ...(landingPath ? { landing_path: landingPath } : {}),
      }
    : stored?.attribution ?? {};
  try {
    if (Object.keys(attribution).length > 0) window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      attribution, capturedAt: newCampaign ? Date.now() : stored!.capturedAt,
      expiresAt: Math.min(consent.expiresAt, newCampaign ? Date.now() + MAX_AGE_MS : stored!.expiresAt),
    }));
    else clearStored();
  } catch (err: unknown) {
    console.warn("[attribution] Failed to store campaign data:", err instanceof Error ? err.name : typeof err);
  }
  return attribution;
}

export function getMarketingAttributionProperties(): Record<string, string> {
  return captureMarketingAttribution();
}

export function getCheckoutAttribution(): (MarketingAttribution & {
  marketing_consent: "accepted"; consent_expires_at: number;
}) | undefined {
  const attribution = captureMarketingAttribution();
  const consent = readAcceptedMarketingConsent();
  return consent ? { ...attribution, marketing_consent: "accepted", consent_expires_at: consent.expiresAt } : undefined;
}
