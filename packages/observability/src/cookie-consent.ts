"use client";

import { createElement, useEffect, useState, type CSSProperties } from "react";
import posthog from "posthog-js";
import { requiresPostHogCookieConsent, type PostHogClientConfig } from "./client.js";

type ConsentStatus = "pending" | "granted" | "denied" | "unknown";
type PostHogLoadState = { __loaded?: boolean };
type PostHogConsentClient = PostHogLoadState & {
  get_explicit_consent_status(): ConsentStatus | undefined;
  opt_in_capturing(): void;
  opt_out_capturing(): void;
};

const COOKIE_CONSENT_STORAGE_KEY = "matrix_posthog_cookie_consent";
const POSTHOG_LOAD_POLL_INTERVAL_MS = 100;
const POSTHOG_LOAD_MAX_RETRIES = 50;
const posthogClient = posthog as unknown as PostHogConsentClient;
type StoredCookieConsent = "accepted" | "declined" | null;
const bannerStyle: CSSProperties = {
  position: "fixed",
  bottom: "1rem",
  right: "0.75rem",
  left: "auto",
  zIndex: 10000,
  width: "min(25rem, calc(100vw - 1.5rem))",
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "0.75rem",
  borderRadius: "0.5rem",
  border: "1px solid rgba(67, 78, 63, 0.18)",
  backgroundColor: "rgba(250, 250, 249, 0.96)",
  padding: "0.875rem",
  color: "#32352e",
  boxShadow: "0 16px 34px -18px rgba(50, 53, 46, 0.35)",
  backdropFilter: "blur(10px)",
};
const pixelAgentStyle: CSSProperties = {
  flex: "0 0 auto",
  width: "4.25rem",
  height: "4.25rem",
  objectFit: "contain",
  transform: "scale(1.25)",
  imageRendering: "pixelated",
};
const contentStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.625rem",
};
const copyStyle: CSSProperties = {
  margin: 0,
  color: "#5c5a4f",
  fontSize: "0.8125rem",
  lineHeight: "1.25rem",
};
const actionsStyle: CSSProperties = {
  display: "flex",
  flexShrink: 0,
  flexDirection: "row",
  gap: "0.5rem",
};
const buttonStyle: CSSProperties = {
  borderRadius: "0.375rem",
  padding: "0.375rem 0.75rem",
  fontSize: "0.8125rem",
  lineHeight: "1.125rem",
};

function getStoredCookieConsent(): StoredCookieConsent {
  try {
    const storedConsent = window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY);
    return storedConsent === "accepted" || storedConsent === "declined" ? storedConsent : null;
  } catch (err: unknown) {
    console.warn("Failed to read PostHog cookie consent:", err instanceof Error ? err.message : err);
    return null;
  }
}

function persistCookieConsent(consent: Exclude<StoredCookieConsent, null>): void {
  try {
    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, consent);
  } catch (err: unknown) {
    console.warn("Failed to store PostHog cookie consent:", err instanceof Error ? err.message : err);
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
  const previewForced =
    process.env.NODE_ENV === "development" &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("previewCookieBanner") === "1";

  useEffect(() => {
    if (!config || !consentRequired) return;
    if (previewForced) {
      setConsentStatus("pending");
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let retries = 0;

    function refreshConsentStatus() {
      if (cancelled) return;
      const storedConsent = getStoredCookieConsent();
      if (storedConsent === "declined") {
        setConsentStatus("denied");
        return;
      }
      if (!posthogClient.__loaded) {
        setConsentStatus(storedConsent === "accepted" ? "granted" : "pending");
        if (retries < POSTHOG_LOAD_MAX_RETRIES) {
          retries += 1;
          timeout = setTimeout(refreshConsentStatus, POSTHOG_LOAD_POLL_INTERVAL_MS);
        }
        return;
      }
      if (storedConsent === "accepted") {
        posthogClient.opt_in_capturing();
        setConsentStatus("granted");
        return;
      }
      setConsentStatus(posthogClient.get_explicit_consent_status() ?? "pending");
    }

    refreshConsentStatus();

    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [config, consentRequired, previewForced]);

  if (!config || !consentRequired || consentStatus !== "pending") return null;

  return createElement(
    "aside",
    {
      "aria-label": "Cookie consent",
      "aria-live": "polite",
      style: bannerStyle,
    },
    createElement(
      "div",
      { style: contentStyle },
      createElement(
        "p",
        { style: copyStyle },
        "Tiny cookie checkpoint. Optional analytics help us improve Matrix OS, and all analytics data stays in the EU.",
      ),
      createElement(
        "div",
        { style: actionsStyle },
        createElement(
          "button",
          {
            type: "button",
            style: {
              ...buttonStyle,
              border: "1px solid rgba(67, 78, 63, 0.22)",
              backgroundColor: "transparent",
              color: "#434e3f",
              fontWeight: 500,
            },
            onClick: () => {
              persistCookieConsent("declined");
              if (posthogClient.__loaded) {
                posthogClient.opt_out_capturing();
              }
              setConsentStatus("denied");
            },
          },
          "Decline",
        ),
        createElement(
          "button",
          {
            type: "button",
            style: {
              ...buttonStyle,
              border: "1px solid #434e3f",
              backgroundColor: "#434e3f",
              color: "#fafaf9",
              fontWeight: 600,
            },
            onClick: () => {
              persistCookieConsent("accepted");
              if (posthogClient.__loaded) {
                posthogClient.opt_in_capturing();
              }
              setConsentStatus("granted");
            },
          },
          "Accept 🍪",
        ),
      ),
    ),
    createElement("img", {
      alt: "Pixel art Matrix cookie mascot",
      height: 60,
      src: "/matrix-cookie.png",
      style: pixelAgentStyle,
      width: 60,
    }),
  );
}
