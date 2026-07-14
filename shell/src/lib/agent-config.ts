import {
  AgentSettingsCompatibleViewSchema,
  AgentSettingsViewSchema,
  type AgentEffort,
  type AgentSettingsUpdate,
  type AgentSettingsView,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { getGatewayUrl } from "./gateway";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SAFE_ERROR_CODE_MAX = 64;

type Fetcher = typeof fetch;

interface ClientOptions {
  fetcher?: Fetcher;
}

export type NormalizedAgentSettings =
  | { kind: "current"; view: AgentSettingsView; updateRequired: false }
  | {
      kind: "legacy";
      view: LegacyShellAgentSettings;
      model: string | null;
      effort: AgentEffort | null;
      updateRequired: true;
    };

export interface LegacyShellAgentSettings {
  identity: Record<string, unknown>;
  kernel: { model: string | null; effort: AgentEffort | null };
  availableModels?: Array<{ id: string; label: string; tier: string }>;
  availableEfforts?: AgentEffort[];
  defaults?: { model: string | null; effort: AgentEffort | null };
}

export class AgentSettingsClientError extends Error {
  constructor(
    readonly kind: "invalid_response" | "unavailable" | "update_failed",
    message: string,
  ) {
    super(message);
    this.name = "AgentSettingsClientError";
  }
}

const ApiKeySuccessSchema = z.object({ valid: z.literal(true) }).strict();

const SAFE_ERRORS: Record<string, string> = {
  agent_config_conflict: "Agent settings changed elsewhere. Refresh and try again.",
  agent_config_invalid: "That agent configuration is not supported.",
  runtime_unavailable: "That runtime is not available on this computer.",
  runtime_switch_failed: "The runtime could not be changed. Your previous runtime is still active.",
  authentication_required: "Authentication is required before this provider can be used.",
  provider_setup_failed: "Provider setup could not be completed.",
};

export function safeAgentSettingsError(value: unknown): string {
  return typeof value === "string" && value.length <= SAFE_ERROR_CODE_MAX
    ? SAFE_ERRORS[value] ?? "Agent settings could not be updated."
    : "Agent settings could not be updated.";
}

function effectiveLegacySelection(view: LegacyShellAgentSettings) {
  return {
    model: view.kernel.model ?? view.defaults?.model ?? null,
    effort: view.kernel.effort ?? view.defaults?.effort ?? null,
  };
}

export function normalizeAgentSettings(value: unknown): NormalizedAgentSettings {
  const parsed = AgentSettingsCompatibleViewSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentSettingsClientError(
      "invalid_response",
      "Agent settings are unavailable.",
    );
  }
  const current = AgentSettingsViewSchema.safeParse(parsed.data);
  if (current.success) {
    return { kind: "current", view: current.data, updateRequired: false };
  }
  const legacy = parsed.data as LegacyShellAgentSettings;
  return {
    kind: "legacy",
    view: legacy,
    ...effectiveLegacySelection(legacy),
    updateRequired: true,
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new AgentSettingsClientError(
      "invalid_response",
      "Agent settings are unavailable.",
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      console.warn("Agent settings response parsing failed", error instanceof Error ? error.name : "UnknownError");
    }
    throw new AgentSettingsClientError(
      "invalid_response",
      "Agent settings are unavailable.",
    );
  }
}

function requestInit(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
}

async function responseError(response: Response): Promise<AgentSettingsClientError> {
  let errorCode: unknown;
  try {
    const value = await boundedJson(response.clone());
    if (value && typeof value === "object") {
      errorCode = (value as { error?: unknown }).error;
    }
  } catch (error) {
    if (!(error instanceof AgentSettingsClientError)) {
      console.warn("Agent settings error response parsing failed", error instanceof Error ? error.name : "UnknownError");
    }
  }
  return new AgentSettingsClientError("update_failed", safeAgentSettingsError(errorCode));
}

export async function loadAgentSettings(
  options: ClientOptions = {},
): Promise<NormalizedAgentSettings> {
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${getGatewayUrl()}/api/settings/agent`, requestInit());
  } catch (error) {
    throw new AgentSettingsClientError(
      "unavailable",
      "Agent settings are unavailable.",
    );
  }
  if (!response.ok) throw await responseError(response);
  return normalizeAgentSettings(await boundedJson(response));
}

export async function updateAgentSettings(
  update: AgentSettingsUpdate,
  options: ClientOptions = {},
): Promise<NormalizedAgentSettings> {
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${getGatewayUrl()}/api/settings/agent`, requestInit({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    }));
  } catch (error) {
    throw new AgentSettingsClientError(
      "unavailable",
      "Agent settings could not be updated.",
    );
  }
  if (!response.ok) throw await responseError(response);
  const value = await boundedJson(response);
  const current = AgentSettingsViewSchema.safeParse(value);
  if (current.success) {
    return { kind: "current", view: current.data, updateRequired: false };
  }
  return loadAgentSettings({ fetcher });
}

export async function saveAnthropicApiKey(
  apiKey: string,
  options: ClientOptions = {},
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${getGatewayUrl()}/api/settings/api-key`, requestInit({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    }));
  } catch (error) {
    throw new AgentSettingsClientError(
      "unavailable",
      "Provider setup could not be completed.",
    );
  }
  if (!response.ok) throw await responseError(response);
  if (!ApiKeySuccessSchema.safeParse(await boundedJson(response)).success) {
    throw new AgentSettingsClientError(
      "invalid_response",
      "Provider setup could not be completed.",
    );
  }
}
