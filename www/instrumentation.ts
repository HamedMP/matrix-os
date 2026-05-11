import { postHogServerErrorReporter } from "./src/lib/posthog-server";

export function register() {
  // PostHog is initialized lazily when an error is captured.
}

export const onRequestError = (
  err: unknown,
  request: {
    headers?: Headers | Record<string, string | string[] | undefined>;
    method?: string;
    path?: string;
    url?: string;
  },
  context: { routeType?: string; routePath?: string; routerKind?: string },
) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  void postHogServerErrorReporter.captureException(err, { request, context }).catch((error: unknown) => {
    console.warn(
      "[posthog] Failed to capture www server exception:",
      error instanceof Error ? error.name : typeof error,
    );
  });
};
