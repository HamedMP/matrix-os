"use client";

import { getPostHogClientConfig } from "@matrix-os/observability/client";
import { PostHogCookieBanner as SharedPostHogCookieBanner } from "@matrix-os/observability/cookie-consent";

const config = getPostHogClientConfig({
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_POSTHOG_API_HOST: process.env.NEXT_PUBLIC_POSTHOG_API_HOST,
});

export function PostHogCookieBanner({ visitorCountry }: { visitorCountry: string | null }) {
  return <SharedPostHogCookieBanner config={config} visitorCountry={visitorCountry} />;
}
