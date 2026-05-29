"use client";

import { useEffect, useState } from "react";
import posthog from "posthog-js";
import {
  getPostHogClientConfig,
  requiresPostHogCookieConsent,
} from "@matrix-os/observability/client";

type ConsentStatus = "pending" | "granted" | "denied" | "unknown";
type PostHogLoadState = { __loaded?: boolean };
const COOKIE_CONSENT_STORAGE_KEY = "matrix_posthog_cookie_consent";

const config = getPostHogClientConfig({
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_POSTHOG_API_HOST: process.env.NEXT_PUBLIC_POSTHOG_API_HOST,
});

function hasDeclinedCookieConsent(): boolean {
  try {
    return window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY) === "declined";
  } catch (err: unknown) {
    console.warn("Failed to read PostHog cookie consent:", err instanceof Error ? err.message : err);
    return false;
  }
}

function persistDeclinedCookieConsent(): void {
  try {
    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, "declined");
  } catch (err: unknown) {
    console.warn("Failed to store PostHog cookie consent:", err instanceof Error ? err.message : err);
  }
}

function clearDeclinedCookieConsent(): void {
  try {
    window.localStorage.removeItem(COOKIE_CONSENT_STORAGE_KEY);
  } catch (err: unknown) {
    console.warn("Failed to clear PostHog cookie consent:", err instanceof Error ? err.message : err);
  }
}

export function PostHogCookieBanner({ visitorCountry }: { visitorCountry: string | null }) {
  const consentRequired = requiresPostHogCookieConsent(visitorCountry);
  const [consentStatus, setConsentStatus] = useState<ConsentStatus>("unknown");

  useEffect(() => {
    if (!config || !consentRequired) return;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    function refreshConsentStatus() {
      if (cancelled) return;
      if (hasDeclinedCookieConsent()) {
        setConsentStatus("denied");
        return;
      }
      if (!(posthog as PostHogLoadState).__loaded) {
        timeout = setTimeout(refreshConsentStatus, 100);
        return;
      }
      setConsentStatus(posthog.get_explicit_consent_status() ?? "pending");
    }

    refreshConsentStatus();

    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [consentRequired]);

  if (!config || !consentRequired || consentStatus !== "pending") return null;

  return (
    <aside
      aria-label="Cookie consent"
      aria-live="polite"
      className="fixed inset-x-3 bottom-3 z-[10000] mx-auto flex max-w-4xl flex-col gap-4 rounded-lg border border-white/14 bg-[#101411]/95 p-4 text-white shadow-2xl shadow-black/35 backdrop-blur md:inset-x-6 md:bottom-6 md:flex-row md:items-center md:justify-between"
    >
      <p className="max-w-2xl text-sm leading-6 text-white/82">
        Matrix OS uses PostHog analytics cookies to understand product usage and improve reliability. You can accept
        analytics cookies or continue with cookieless tracking.
      </p>
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
        <button
          type="button"
          className="rounded-md border border-white/20 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          onClick={() => {
            if (!(posthog as PostHogLoadState).__loaded) return;
            persistDeclinedCookieConsent();
            setConsentStatus("denied");
          }}
        >
          Decline
        </button>
        <button
          type="button"
          className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-[#101411] transition hover:bg-white/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          onClick={() => {
            if (!(posthog as PostHogLoadState).__loaded) return;
            clearDeclinedCookieConsent();
            posthog.opt_in_capturing();
            setConsentStatus("granted");
          }}
        >
          Accept
        </button>
      </div>
    </aside>
  );
}
