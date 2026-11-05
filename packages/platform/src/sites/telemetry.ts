import type { MatrixTelemetryEvent } from '@matrix-os/observability';

export type SiteTelemetryProperties = Record<string, string | number | boolean | null | undefined>;
export type SiteTelemetryCapture = (
    event: MatrixTelemetryEvent,
    properties: SiteTelemetryProperties,
    options?: { distinctId?: string },
) => void;

/** Product telemetry is best-effort and must never change site behavior. */
export function emitSiteTelemetry(
    capture: SiteTelemetryCapture | undefined,
    event: MatrixTelemetryEvent,
    properties: SiteTelemetryProperties,
    distinctId?: string,
): void {
    if (!capture) return;
    try {
        if (distinctId) capture(event, properties, { distinctId });
        else capture(event, properties);
    } catch (error) {
        console.warn('[sites] telemetry capture failed', error instanceof Error ? error.name : 'UnknownError');
    }
}
