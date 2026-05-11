import { createPostHogServerExceptionReporter } from "@matrix-os/observability";

const reporter = createPostHogServerExceptionReporter({
  service: "matrix-shell",
});

export function register() {
  // PostHog is initialized lazily when an error is captured.
}

export const onRequestError = async (
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
  await reporter.captureException(err, { request, context });
};
