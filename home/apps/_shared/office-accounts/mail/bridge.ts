/**
 * The one path from a mail adapter to `window.MatrixOS.service(...)`.
 *
 * - Every failure becomes a `ProviderError`; bridge, gateway and provider text
 *   is never passed on.
 * - Identical reads that are in flight at the same time share one request.
 * - Writes are never shared and never retried.
 */
import type { MatrixOSBridge, MatrixOSServiceResult } from "../../matrix-os";
import { ProviderError, isProviderError, providerErrorCodeForStatus } from "../types/mail.js";

/** The part of the bridge the account layer and the adapters use. */
export type ServiceBridge = Pick<MatrixOSBridge, "service" | "integrations" | "capabilities">;

/** `window.MatrixOS`, or `not_supported` when this host has no integrations bridge. */
export function defaultBridge(): ServiceBridge {
  const bridge = (globalThis as { MatrixOS?: Partial<MatrixOSBridge>; window?: { MatrixOS?: Partial<MatrixOSBridge> } });
  const candidate = bridge.window?.MatrixOS ?? bridge.MatrixOS;
  if (!candidate || typeof candidate.service !== "function" || typeof candidate.integrations !== "function"
    || typeof candidate.capabilities !== "function") {
    throw new ProviderError("not_supported", "Mail accounts are not available here.");
  }
  return candidate as ServiceBridge;
}

/**
 * Maps anything a bridge call rejects with to a `ProviderError`. A numeric
 * `status` on the error (the gateway's HTTP status) selects the code;
 * without one the failure is `failed`. The original text is dropped.
 */
export function bridgeFailure(error: unknown): ProviderError {
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

export interface ServiceCaller {
  readonly service: string;
  readonly label: string | undefined;
  /** Runs a read. Concurrent identical reads share one request. Resolves to the provider JSON. */
  read<T>(action: string, params?: Record<string, unknown>): Promise<T>;
  /** Runs a write once. Resolves to the provider JSON, which is empty for 202 and 204 replies. */
  write<T>(action: string, params?: Record<string, unknown>): Promise<T>;
}

/** Cap on shared in-flight reads; beyond it reads simply run unshared. */
const MAX_SHARED_READS = 64;

export function createServiceCaller(bridge: ServiceBridge, service: string, label?: string): ServiceCaller {
  const inFlight = new Map<string, Promise<unknown>>();

  async function call<T>(action: string, params: Record<string, unknown>): Promise<T> {
    let reply: MatrixOSServiceResult<T>;
    try {
      reply = label === undefined
        ? await bridge.service<T>(service, action, params)
        : await bridge.service<T>(service, action, params, label);
    } catch (error: unknown) {
      const failure = bridgeFailure(error);
      logFailure(service, action, failure);
      throw failure;
    }
    if (typeof reply !== "object" || reply === null || !("data" in reply)) {
      const failure = new ProviderError("failed");
      logFailure(service, action, failure);
      throw failure;
    }
    return reply.data;
  }

  return {
    service,
    label,
    read<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
      const key = `${action}\u0000${JSON.stringify(params)}`;
      const shared = inFlight.get(key);
      if (shared) return shared as Promise<T>;
      const request = call<T>(action, params);
      if (inFlight.size < MAX_SHARED_READS) {
        inFlight.set(key, request);
        const clear = () => { if (inFlight.get(key) === request) inFlight.delete(key); };
        request.then(clear, clear);
      }
      return request;
    },
    write<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
      return call<T>(action, params);
    },
  };
}

/** Reads a field of provider JSON as an object, or an empty object for anything else. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d{1,16}$/.test(value)) return Number(value);
  return undefined;
}
