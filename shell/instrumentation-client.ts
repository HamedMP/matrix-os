import posthog from "posthog-js";
import {
  buildPostHogCookieConsentInitOptions,
  getPostHogClientConfig,
  resolvePostHogClientApiHost,
} from "@matrix-os/observability/client";

type PostHogInitOptions = Parameters<typeof posthog.init>[1];

const config = getPostHogClientConfig({
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_POSTHOG_API_HOST: process.env.NEXT_PUBLIC_POSTHOG_API_HOST,
});

if (config) {
  posthog.init(config.token, {
    // Shell has no local PostHog /ingest proxy, so an unset api_host lets
    // posthog-js use its default endpoint.
    api_host: resolvePostHogClientApiHost(config, { allowRelativeApiHost: false }),
    ui_host: config.uiHost,
    defaults: "2026-01-30",
    capture_exceptions: true,
    debug: process.env.NODE_ENV === "development",
    ...buildPostHogCookieConsentInitOptions(document.documentElement.dataset.posthogVisitorCountry),
  } as PostHogInitOptions);
}
