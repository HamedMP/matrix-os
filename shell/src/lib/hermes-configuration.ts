import { z } from "zod/v4";
import { getGatewayUrl } from "./gateway";

const RESPONSE_LIMIT_BYTES = 1024 * 1024;
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 15_000;

const ConfigFieldSchema = z.object({
  type: z.enum(["boolean", "number", "string", "select", "list"]),
  description: z.string().max(512),
  category: z.string().max(64),
  options: z.array(z.string().max(256)).max(128).optional(),
}).strict();

const ConfigurationSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  defaults: z.record(z.string(), z.unknown()),
  fields: z.record(z.string(), ConfigFieldSchema),
  categoryOrder: z.array(z.string().max(64)).max(64),
}).strict();

const EnvironmentEntrySchema = z.object({
  is_set: z.boolean(),
  redacted_value: z.string().nullable().optional(),
  description: z.string().max(512).default(""),
  url: z.string().nullable().optional(),
  category: z.string().max(64).default(""),
  is_password: z.boolean().default(true),
  tools: z.array(z.string()).max(128).default([]),
  advanced: z.boolean().default(false),
  channel_managed: z.boolean().default(false),
  provider: z.string().max(128).default(""),
  provider_label: z.string().max(128).default(""),
});

const EnvironmentSchema = z.record(z.string(), EnvironmentEntrySchema);
const SaveResponseSchema = z.object({ ok: z.literal(true) }).passthrough();

export type HermesConfiguration = z.infer<typeof ConfigurationSchema>;
export type HermesConfigField = z.infer<typeof ConfigFieldSchema>;
export type HermesEnvironment = z.infer<typeof EnvironmentSchema>;
export type HermesConfigValue = string | number | boolean | Array<string | number | boolean>;
export interface HermesConfigChange {
  path: string;
  value: HermesConfigValue;
}

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
  const parsed = ConfigurationSchema.safeParse(await request("/api/hermes/configuration"));
  if (!parsed.success) throw new HermesConfigurationError();
  return parsed.data;
}

export async function loadHermesEnvironment(): Promise<HermesEnvironment> {
  const parsed = EnvironmentSchema.safeParse(await request("/api/hermes/env"));
  if (!parsed.success) throw new HermesConfigurationError();
  return parsed.data;
}

export async function saveHermesConfiguration(changes: HermesConfigChange[]): Promise<void> {
  const parsed = SaveResponseSchema.safeParse(await request("/api/hermes/configuration", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ changes }),
  }, WRITE_TIMEOUT_MS));
  if (!parsed.success) throw new HermesConfigurationError("Hermes configuration could not be saved.");
}

export async function saveHermesCredential(key: string, value: string): Promise<void> {
  const parsed = SaveResponseSchema.safeParse(await request("/api/hermes/env", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, value }),
  }, WRITE_TIMEOUT_MS));
  if (!parsed.success) throw new HermesConfigurationError("Hermes credential could not be saved.");
}

export async function removeHermesCredential(key: string): Promise<void> {
  const parsed = SaveResponseSchema.safeParse(await request("/api/hermes/env", {
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
