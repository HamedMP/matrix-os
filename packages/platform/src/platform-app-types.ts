import type { Hono } from 'hono';
import type { MatrixTelemetryEvent } from '@matrix-os/observability';

export type PlatformApp = Hono<{
  Variables: {
    platformUserId: string;
    platformHandle: string;
    internalContainerHandle: string;
    internalContainerClerkUserId: string;
  };
}> & {
  capturePlatformEvent(
    event: MatrixTelemetryEvent,
    properties: Record<string, string | number | boolean | null | undefined>,
    options?: { distinctId?: string },
  ): void;
  shutdownPostHog(): Promise<void>;
};
