import { createPostHogServerExceptionReporter, getPostHogConfig } from '@matrix-os/observability';
import { PostHog } from 'posthog-node';

type AnalyticsClient = Pick<PostHog, 'capture' | 'identify' | 'captureException' | 'flush' | 'shutdown'>;

const noopClient: AnalyticsClient = {
  capture: (..._args: Parameters<PostHog['capture']>) => undefined,
  identify: (..._args: Parameters<PostHog['identify']>) => undefined,
  captureException: (..._args: Parameters<PostHog['captureException']>) => undefined,
  flush: async () => undefined,
  shutdown: async () => undefined,
};

let posthogClient: AnalyticsClient | null = null;

export const postHogServerErrorReporter = createPostHogServerExceptionReporter({
  service: 'matrix-www',
});

export function getPostHogClient() {
  if (!posthogClient) {
    const config = getPostHogConfig();
    if (!config) {
      posthogClient = noopClient;
      return posthogClient;
    }
    posthogClient = new PostHog(config.token, {
      ...(config.host ? { host: config.host } : {}),
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return posthogClient;
}

export async function shutdownPostHog() {
  await postHogServerErrorReporter.shutdown();
  if (posthogClient) {
    await posthogClient.shutdown();
    posthogClient = null;
  }
}
