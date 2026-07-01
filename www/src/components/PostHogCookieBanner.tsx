"use client";

import { useEffect, useState } from "react";
import { getPostHogClientConfig } from "@matrix-os/observability/client";

const config = getPostHogClientConfig({
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_POSTHOG_API_HOST: process.env.NEXT_PUBLIC_POSTHOG_API_HOST ?? "/relay",
});

type SharedPostHogCookieBanner = typeof import("@matrix-os/observability/cookie-consent").PostHogCookieBanner;
type MatrixIdleDeadline = { didTimeout: boolean; timeRemaining(): number };
type IdleCallbackHandle = ReturnType<typeof setTimeout>;
type IdleWindow = Window &
  typeof globalThis & {
    requestIdleCallback?: (callback: (deadline: MatrixIdleDeadline) => void, options?: { timeout: number }) => IdleCallbackHandle;
    cancelIdleCallback?: (handle: IdleCallbackHandle) => void;
  };

let cookieBannerPromise: Promise<SharedPostHogCookieBanner> | null = null;

function loadCookieBanner(): Promise<SharedPostHogCookieBanner> {
  cookieBannerPromise ??= import("@matrix-os/observability/cookie-consent").then(
    (module) => module.PostHogCookieBanner,
  );
  return cookieBannerPromise;
}

export function PostHogCookieBanner({ visitorCountry }: { visitorCountry: string | null }) {
  const [Banner, setBanner] = useState<SharedPostHogCookieBanner | null>(null);

  useEffect(() => {
    const idleWindow = window as IdleWindow;
    let cancelled = false;

    const loadBannerAfterIdle = () => {
      void loadCookieBanner()
        .then((CookieBanner) => {
          if (!cancelled) setBanner(() => CookieBanner);
        })
        .catch((err: unknown) => {
          console.warn("[posthog] Failed to load cookie banner:", err instanceof Error ? err.name : typeof err);
        });
    };

    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(loadBannerAfterIdle, { timeout: 2500 });
      return () => {
        cancelled = true;
        idleWindow.cancelIdleCallback?.(handle);
      };
    }

    const handle = window.setTimeout(loadBannerAfterIdle, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, []);

  return Banner ? <Banner config={config} visitorCountry={visitorCountry} /> : null;
}
