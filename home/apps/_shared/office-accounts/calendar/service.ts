/**
 * The one path from a calendar adapter to `window.MatrixOS.service(...)`.
 *
 * Every failure becomes a `ProviderError`; bridge, gateway and provider text is
 * never passed on. Nothing here retries: a write runs exactly once.
 */
import type { MatrixOSBridge } from "../../matrix-os";
import { ProviderError, isProviderError, providerErrorCodeForStatus } from "../types/calendar.js";
import type { CalendarAccount } from "../types/calendar.js";

/** The part of the bridge an adapter needs. */
export type CalendarServiceBridge = Pick<MatrixOSBridge, "service">;

export interface CalendarProviderOptions {
  account: CalendarAccount;
  /** The integration account label; omit when only one account of the service is connected. */
  label?: string;
  bridge: CalendarServiceBridge;
}

export interface CalendarCaller {
  readonly service: string;
  /** Resolves to the provider JSON (`data`), which is empty for 202 and 204 replies. */
  call(action: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Maps anything a bridge call rejects with to a `ProviderError`, dropping its text. */
export function calendarBridgeFailure(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (isProviderError(error)) return new ProviderError(error.code);
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  if (typeof status === "number" && Number.isInteger(status)) return new ProviderError(providerErrorCodeForStatus(status));
  return new ProviderError("failed");
}

function logFailure(service: string, action: string, error: ProviderError): void {
  // Only the code is logged: provider text can carry account details.
  console.warn(`[office-accounts] ${service}/${action} failed`, error.code);
}

export function createCalendarCaller(bridge: CalendarServiceBridge, service: string, label: string | undefined): CalendarCaller {
  return {
    service,
    async call(action, params) {
      let reply: unknown;
      try {
        reply = label === undefined
          ? await bridge.service(service, action, params)
          : await bridge.service(service, action, params, label);
      } catch (error: unknown) {
        const failure = calendarBridgeFailure(error);
        logFailure(service, action, failure);
        throw failure;
      }
      if (typeof reply !== "object" || reply === null || !("data" in reply)) {
        const failure = new ProviderError("failed");
        logFailure(service, action, failure);
        throw failure;
      }
      return (reply as { data: unknown }).data;
    },
  };
}

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A list reply must be an object; anything else is an unexpected reply. */
export function requireRecord(value: unknown, service: string, action: string): JsonRecord {
  if (isRecord(value)) return value;
  const failure = new ProviderError("failed");
  logFailure(service, action, failure);
  throw failure;
}
