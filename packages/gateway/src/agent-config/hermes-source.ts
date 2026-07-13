import {
  AgentProviderDescriptorSchema,
  type AgentAuthKind,
  type AgentProviderDescriptor,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { AgentRuntimeSettingsSnapshot } from "./service.js";

export type HermesJsonReader = (
  path: string,
  signal: AbortSignal,
) => Promise<unknown>;

const MAX_HERMES_PROVIDERS = 31;
const MAX_HERMES_MODELS = 253;
const MAX_MODELS_PER_PROVIDER = 128;

const ProviderIdSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
const ModelIdSchema = z.string().trim().min(1).max(160);
const DisplayNameSchema = z.string().trim().min(1).max(120);
const VersionSchema = z.string().trim().min(1).max(64);

const HermesStatusSchema = z.object({
  gateway_running: z.boolean().optional(),
  version: z.unknown().optional(),
}).passthrough();

const HermesOptionsSchema = z.object({
  provider: z.unknown().optional(),
  model: z.unknown().optional(),
  providers: z.array(z.unknown()).max(128),
}).passthrough();

const HermesProviderSchema = z.object({
  slug: z.unknown(),
  name: z.unknown().optional(),
  authenticated: z.boolean().optional(),
  auth_type: z.string().max(64).optional(),
  is_user_defined: z.boolean().optional(),
  models: z.array(z.unknown()).max(512).optional(),
}).passthrough();

function authKindForProvider(
  authType: string | undefined,
  isUserDefined: boolean,
): AgentAuthKind {
  if (isUserDefined || authType === "base_url" || authType === "custom") {
    return "base_url";
  }
  if (authType === "api_key") return "api_key";
  return "oauth_login";
}

function authAction(authKind: AgentAuthKind) {
  if (authKind === "api_key") return "enter_api_key" as const;
  if (authKind === "base_url") return "configure_base_url" as const;
  if (authKind === "oauth_login") return "open_login_terminal" as const;
  return "contact_owner" as const;
}

function parseModelIds(rawModels: unknown[] | undefined, currentModel: string | null) {
  const models: string[] = [];
  const seen = new Set<string>();
  for (const candidate of rawModels ?? []) {
    const parsed = ModelIdSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data)) continue;
    seen.add(parsed.data);
    models.push(parsed.data);
    if (models.length === MAX_MODELS_PER_PROVIDER) break;
  }
  models.sort((left, right) => left.localeCompare(right));
  if (currentModel === null) return models;
  const selectedIndex = models.indexOf(currentModel);
  if (selectedIndex !== -1) models.splice(selectedIndex, 1);
  return [currentModel, ...models].slice(0, MAX_MODELS_PER_PROVIDER);
}

function normalizeProvider(
  raw: unknown,
  currentProvider: string | null,
  currentModel: string | null,
): AgentProviderDescriptor | null {
  const parsed = HermesProviderSchema.safeParse(raw);
  if (!parsed.success) return null;
  const id = ProviderIdSchema.safeParse(parsed.data.slug);
  if (!id.success) return null;
  const name = DisplayNameSchema.safeParse(parsed.data.name);
  const authenticated = parsed.data.authenticated === true;
  const authKind = authKindForProvider(
    parsed.data.auth_type,
    parsed.data.is_user_defined === true,
  );
  const models = parseModelIds(
    parsed.data.models,
    id.data === currentProvider ? currentModel : null,
  ).map((model) => ({
    id: model,
    displayName: model,
    capabilities: ["tools" as const],
    efforts: [],
    available: true,
  }));
  const provider = {
    id: id.data,
    displayName: name.success ? name.data : id.data,
    runtime: "hermes" as const,
    scopes: ["messaging" as const],
    authKind,
    supportedAuthKinds: [authKind],
    models,
    authStatus: authenticated
      ? { state: "ready" as const, authenticated: true, action: "none" as const }
      : {
          state: "action_required" as const,
          authenticated: false,
          action: authAction(authKind),
        },
  };
  const validated = AgentProviderDescriptorSchema.safeParse(provider);
  return validated.success ? validated.data : null;
}

export function normalizeHermesRuntimeSnapshot(input: {
  status: unknown;
  options: unknown;
}): AgentRuntimeSettingsSnapshot {
  const status = HermesStatusSchema.parse(input.status);
  const options = HermesOptionsSchema.parse(input.options);
  const currentProviderResult = ProviderIdSchema.safeParse(options.provider);
  const currentModelResult = ModelIdSchema.safeParse(options.model);
  const currentProvider = currentProviderResult.success
    ? currentProviderResult.data
    : null;
  const currentModel = currentModelResult.success ? currentModelResult.data : null;
  const normalizedProviders: AgentProviderDescriptor[] = [];
  for (const rawProvider of options.providers) {
    const provider = normalizeProvider(rawProvider, currentProvider, currentModel);
    if (!provider) continue;
    const duplicateIndex = normalizedProviders.findIndex(
      (entry) => entry.id === provider.id,
    );
    if (duplicateIndex === -1) {
      normalizedProviders.push(provider);
    } else if (normalizedProviders[duplicateIndex]?.authStatus.state !== "ready"
      && provider.authStatus.state === "ready") {
      normalizedProviders[duplicateIndex] = provider;
    }
  }
  normalizedProviders.sort((left, right) => {
    const selectedDifference = Number(right.id === currentProvider)
      - Number(left.id === currentProvider);
    if (selectedDifference !== 0) return selectedDifference;
    const readyDifference = Number(right.authStatus.state === "ready")
      - Number(left.authStatus.state === "ready");
    return readyDifference !== 0
      ? readyDifference
      : left.id.localeCompare(right.id);
  });

  const providers: AgentProviderDescriptor[] = [];
  let modelCount = 0;
  for (const provider of normalizedProviders) {
    const remainingModels = MAX_HERMES_MODELS - modelCount;
    if (remainingModels <= 0) break;
    const boundedProvider = provider.models.length <= remainingModels
      ? provider
      : { ...provider, models: provider.models.slice(0, remainingModels) };
    providers.push(boundedProvider);
    modelCount += boundedProvider.models.length;
    if (providers.length === MAX_HERMES_PROVIDERS) break;
  }

  const selectedProvider = currentProvider === null
    ? undefined
    : providers.find((provider) => provider.id === currentProvider);
  const hasSelection = currentModel !== null
    && selectedProvider?.models.some((model) => model.id === currentModel) === true;
  const configured = currentProvider !== null && currentModel !== null && hasSelection;
  const version = VersionSchema.safeParse(status.version);

  return {
    runtime: {
      selected: "hermes",
      options: [
        {
          id: "hermes",
          displayName: "Hermes",
          installState: "installed",
          health: status.gateway_running === true ? "healthy" : "degraded",
          selectionState: "active",
          configured,
          ...(version.success ? { version: version.data } : {}),
          capabilities: [
            "provider_catalog",
            "model_selection",
            "authentication",
            "messaging_dashboard",
          ],
        },
        {
          id: "openclaw",
          displayName: "OpenClaw",
          installState: "missing",
          health: "stopped",
          selectionState: "unavailable",
          configured: false,
          capabilities: ["install"],
          setupAction: "install",
        },
      ],
      transition: null,
    },
    providers,
    messaging: {
      runtime: "hermes",
      provider: configured ? currentProvider : null,
      model: configured ? currentModel : null,
      configured,
    },
  };
}

export function createHermesRuntimeSource(
  readJson: HermesJsonReader,
  options: {
    cacheTtlMs?: number;
    now?: () => number;
    logWarning?: (errorName: string) => void;
  } = {},
) {
  const cacheTtlMs = options.cacheTtlMs ?? 5_000;
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 60_000) {
    throw new RangeError("Invalid Hermes settings cache TTL");
  }
  const now = options.now ?? Date.now;
  const logWarning = options.logWarning ?? ((errorName: string) => {
    console.warn("[agent-config] Hermes settings probe failed:", errorName);
  });
  let cached: { value: AgentRuntimeSettingsSnapshot; expiresAt: number } | null = null;
  let inFlight: Promise<AgentRuntimeSettingsSnapshot> | null = null;

  return async (signal: AbortSignal): Promise<AgentRuntimeSettingsSnapshot> => {
    signal.throwIfAborted();
    if (cached !== null && cached.expiresAt > now()) return cached.value;
    if (inFlight === null) {
      inFlight = Promise.all([
        readJson("/api/status", signal),
        readJson("/api/model/options", signal),
      ]).then(([status, modelOptions]) => {
        return normalizeHermesRuntimeSnapshot({
          status,
          options: modelOptions,
        });
      }).catch((err: unknown) => {
        logWarning(err instanceof Error ? err.name : "UnknownError");
        return unavailableHermesRuntimeSnapshot();
      }).then((value) => {
        cached = { value, expiresAt: now() + cacheTtlMs };
        return value;
      }).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

function unavailableHermesRuntimeSnapshot(): AgentRuntimeSettingsSnapshot {
  return {
    runtime: {
      selected: "hermes",
      options: [
        {
          id: "hermes",
          displayName: "Hermes",
          installState: "unknown",
          health: "unreachable",
          selectionState: "active",
          configured: false,
          capabilities: [
            "provider_catalog",
            "model_selection",
            "authentication",
            "messaging_dashboard",
          ],
        },
        {
          id: "openclaw",
          displayName: "OpenClaw",
          installState: "missing",
          health: "stopped",
          selectionState: "unavailable",
          configured: false,
          capabilities: ["install"],
          setupAction: "install",
        },
      ],
      transition: null,
    },
    providers: [],
    messaging: {
      runtime: "hermes",
      provider: null,
      model: null,
      configured: false,
    },
  };
}
