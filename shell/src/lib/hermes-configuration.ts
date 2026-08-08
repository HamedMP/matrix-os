import {
  HermesConfigurationSchema,
  HermesEnvironmentSchema,
  HermesMutationResponseSchema,
  type HermesConfigChange,
  type HermesConfigField,
  type HermesConfigValue,
  type HermesConfiguration,
  type HermesEnvironment,
} from "@matrix-os/contracts";
import { getGatewayUrl } from "./gateway";

const RESPONSE_LIMIT_BYTES = 1024 * 1024;
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 15_000;

export type {
  HermesConfigChange,
  HermesConfigField,
  HermesConfigValue,
  HermesConfiguration,
  HermesEnvironment,
};

export class HermesConfigurationError extends Error {
  constructor(message = "Hermes configuration is unavailable.") {
    super(message);
    this.name = "HermesConfigurationError";
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > RESPONSE_LIMIT_BYTES) {
    throw new HermesConfigurationError();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    console.warn(
      "Hermes configuration response parsing failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    throw new HermesConfigurationError();
  }
}

async function request(path: string, init: RequestInit = {}, timeoutMs = READ_TIMEOUT_MS): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${getGatewayUrl()}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    console.warn(
      "Hermes configuration request failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    throw new HermesConfigurationError();
  }
  if (!response.ok) {
    throw new HermesConfigurationError(
      init.method ? "Hermes configuration could not be saved." : undefined,
    );
  }
  return boundedJson(response);
}

export async function loadHermesConfiguration(): Promise<HermesConfiguration> {
  const parsed = HermesConfigurationSchema.safeParse(await request("/api/hermes/configuration"));
  if (!parsed.success) throw new HermesConfigurationError();
  return parsed.data;
}

export async function loadHermesEnvironment(): Promise<HermesEnvironment> {
  const parsed = HermesEnvironmentSchema.safeParse(await request("/api/hermes/env"));
  if (!parsed.success) throw new HermesConfigurationError();
  return parsed.data;
}

export async function saveHermesConfiguration(changes: HermesConfigChange[]): Promise<void> {
  const parsed = HermesMutationResponseSchema.safeParse(await request("/api/hermes/configuration", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ changes }),
  }, WRITE_TIMEOUT_MS));
  if (!parsed.success) throw new HermesConfigurationError("Hermes configuration could not be saved.");
}

export async function saveHermesCredential(key: string, value: string): Promise<void> {
  const parsed = HermesMutationResponseSchema.safeParse(await request("/api/hermes/env", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, value }),
  }, WRITE_TIMEOUT_MS));
  if (!parsed.success) throw new HermesConfigurationError("Hermes credential could not be saved.");
}

export async function removeHermesCredential(key: string): Promise<void> {
  const parsed = HermesMutationResponseSchema.safeParse(await request("/api/hermes/env", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  }, WRITE_TIMEOUT_MS));
  if (!parsed.success) throw new HermesConfigurationError("Hermes credential could not be removed.");
}

export function configValueAt(config: Record<string, unknown>, path: string): unknown {
  let value: unknown = config;
  for (const segment of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}
