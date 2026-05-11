import posthog from "posthog-js";
import { getPostHogClientConfig } from "@matrix-os/observability/client";

const config = getPostHogClientConfig(process.env);

if (config) {
  posthog.init(config.token, {
    api_host: config.apiHost ?? config.uiHost,
    ui_host: config.uiHost,
    defaults: "2026-01-30",
    capture_exceptions: true,
    debug: process.env.NODE_ENV === "development",
  } as never);
}
