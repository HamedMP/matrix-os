import { createPostHogServerExceptionReporter } from "@matrix-os/observability";

export const shellPostHogReporter = createPostHogServerExceptionReporter({
  service: "matrix-shell",
});

export function register() {
  // PostHog is initialized lazily when an error is captured.
}

export async function unregister() {
  await shellPostHogReporter.shutdown();
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
  void shellPostHogReporter.captureException(err, { request, context }).catch((error: unknown) => {
    console.warn(
      "[posthog] Failed to capture shell server exception:",
      error instanceof Error ? error.name : typeof error,
    );
  });
};
