"use client";

import { createElement, useEffect, useState } from "react";
import posthog from "posthog-js";
import { requiresPostHogCookieConsent, type PostHogClientConfig } from "./client.js";

type ConsentStatus = "pending" | "granted" | "denied" | "unknown";
type PostHogLoadState = { __loaded?: boolean };
type PostHogConsentClient = PostHogLoadState & {
  get_explicit_consent_status(): ConsentStatus | undefined;
  opt_in_capturing(): void;
};

const COOKIE_CONSENT_STORAGE_KEY = "matrix_posthog_cookie_consent";
const POSTHOG_LOAD_POLL_INTERVAL_MS = 100;
const POSTHOG_LOAD_MAX_RETRIES = 50;
const posthogClient = posthog as unknown as PostHogConsentClient;

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

export function PostHogCookieBanner({
  config,
  visitorCountry,
}: {
  config: PostHogClientConfig | null;
  visitorCountry: string | null;
}) {
  const consentRequired = requiresPostHogCookieConsent(visitorCountry);
  const [consentStatus, setConsentStatus] = useState<ConsentStatus>("unknown");

  useEffect(() => {
    if (!config || !consentRequired) return;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let retries = 0;

    function refreshConsentStatus() {
      if (cancelled) return;
      if (hasDeclinedCookieConsent()) {
        setConsentStatus("denied");
        return;
      }
      if (!posthogClient.__loaded) {
        if (retries < POSTHOG_LOAD_MAX_RETRIES) {
          retries += 1;
          timeout = setTimeout(refreshConsentStatus, POSTHOG_LOAD_POLL_INTERVAL_MS);
        }
        return;
      }
      setConsentStatus(posthogClient.get_explicit_consent_status() ?? "pending");
    }

    refreshConsentStatus();

    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [config, consentRequired]);

  if (!config || !consentRequired || consentStatus !== "pending") return null;

  return createElement(
    "aside",
    {
      "aria-label": "Cookie consent",
      "aria-live": "polite",
      className:
        "fixed inset-x-3 bottom-3 z-[10000] mx-auto flex max-w-4xl flex-col gap-4 rounded-lg border border-white/15 bg-[#101411]/95 p-4 text-white shadow-2xl shadow-black/35 backdrop-blur md:inset-x-6 md:bottom-6 md:flex-row md:items-center md:justify-between",
    },
    createElement(
      "p",
      { className: "max-w-2xl text-sm leading-6 text-white/82" },
      "Matrix OS uses PostHog analytics cookies to understand product usage and improve reliability. You can accept analytics cookies or continue with cookieless tracking.",
    ),
    createElement(
      "div",
      { className: "flex shrink-0 flex-col gap-2 sm:flex-row" },
      createElement(
        "button",
        {
          type: "button",
          className:
            "rounded-md border border-white/20 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
          onClick: () => {
            if (!posthogClient.__loaded) return;
            persistDeclinedCookieConsent();
            setConsentStatus("denied");
          },
        },
        "Decline",
      ),
      createElement(
        "button",
        {
          type: "button",
          className:
            "rounded-md bg-white px-4 py-2 text-sm font-semibold text-[#101411] transition hover:bg-white/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
          onClick: () => {
            if (!posthogClient.__loaded) return;
            clearDeclinedCookieConsent();
            posthogClient.opt_in_capturing();
            setConsentStatus("granted");
          },
        },
        "Accept",
      ),
    ),
  );
}
