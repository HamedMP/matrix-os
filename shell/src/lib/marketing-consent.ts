"use client";

const CONSENT_KEY = "matrix_marketing_consent_v1";
const MAX_CONSENT_AGE_MS = 180 * 86_400_000;

/** Read the existing website choice. A shared rejection overrides an old local acceptance. */
export function readAcceptedMarketingConsent(): { expiresAt: number } | undefined {
  if (typeof window === "undefined" || typeof document === "undefined") return undefined;
  try {
    const entry = document.cookie.split(";").map(part => part.trim())
      .find(part => part.startsWith(`${CONSENT_KEY}=`));
    const raw = entry ? decodeURIComponent(entry.slice(CONSENT_KEY.length + 1))
      : window.localStorage.getItem(CONSENT_KEY);
    if (!raw || raw.length > 1024) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const choice = value as Record<string, unknown>;
    const now = Date.now();
    return choice.version === 1 && choice.choice === "accepted"
      && typeof choice.expiresAt === "number" && Number.isSafeInteger(choice.expiresAt)
      && choice.expiresAt > now && choice.expiresAt <= now + MAX_CONSENT_AGE_MS
      ? { expiresAt: choice.expiresAt } : undefined;
  } catch (error: unknown) {
    console.warn("[attribution] Consent unavailable:", error instanceof Error ? error.name : typeof error);
    return undefined;
  }
}
