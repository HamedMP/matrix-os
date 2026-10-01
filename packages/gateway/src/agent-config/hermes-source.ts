import {
  AgentProviderDescriptorSchema,
  type AgentAuthKind,
  type AgentProviderDescriptor,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type {
  AgentRuntimeSettingsSnapshot,
  AgentRuntimeSource,
} from "./service.js";

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
  auth_type: z.string().max(64).nullable().optional(),
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
    if (!parsed.success || parsed.data.endsWith("-pro") || seen.has(parsed.data)) {
      continue;
    }
    seen.add(parsed.data);
    models.push(parsed.data);
    if (models.length === MAX_MODELS_PER_PROVIDER) break;
  }
  models.sort((left, right) => left.localeCompare(right));
  if (currentModel === null || currentModel.endsWith("-pro")) return models;
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
    parsed.data.auth_type ?? undefined,
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

function nativeProviderRecord(rawProviders: unknown[], providerId: string | null) {
  const records = rawProviders.filter((raw) => typeof raw === "object" && raw !== null
    && "slug" in raw && typeof raw.slug === "string" && raw.slug.trim() === providerId);
  const parsed = records.length === 1 ? HermesProviderSchema.safeParse(records[0]) : undefined;
  return parsed?.success ? parsed.data : undefined;
}

function nativeCredentialKind(providerId: string | null, provider: z.infer<typeof HermesProviderSchema> | undefined) {
  if (provider?.is_user_defined === true) return "custom" as const;
  // The pinned native registry omits auth_type for these built-in routes.
  // Only explicit non-user-defined records can supply this default; ambiguous
  // inventories and explicit alternate auth kinds remain closed.
  const builtin = provider?.is_user_defined === false && provider.auth_type === undefined;
  const builtinCodexProfile = providerId === "openai-codex" && builtin;
  if (provider?.auth_type === "oauth" || builtinCodexProfile) return "provider_profile" as const;
  if (provider?.auth_type === "api_key"
    || (builtin && (providerId === "openai-api" || providerId === "openrouter"))) return "api_key" as const;
  if (provider?.auth_type === "base_url" || provider?.auth_type === "custom") return "custom" as const;
  return undefined;
}

export function normalizeHermesRuntimeSnapshot(input: {
  status: unknown;
  options: unknown;
  observedAt?: number;
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

  const boundedProviders = normalizedProviders.slice(0, MAX_HERMES_PROVIDERS);
  const providers: AgentProviderDescriptor[] = boundedProviders.map((provider) => ({ ...provider, models: [] }));
  let modelCount = 0;
  // Keep each provider represented before giving a large inventory more slots.
  // The selected provider and its selected model are already first.
  for (let position = 0; modelCount < MAX_HERMES_MODELS; position++) {
    let hasPosition = false;
    for (let index = 0; index < boundedProviders.length && modelCount < MAX_HERMES_MODELS; index++) {
      const model = boundedProviders[index]!.models[position];
      if (!model) continue;
      hasPosition = true;
      providers[index]!.models.push(model);
      modelCount++;
    }
    if (!hasPosition) break;
  }

  const selectedProvider = currentProvider === null
    ? undefined
    : providers.find((provider) => provider.id === currentProvider);
  const hasSelection = currentModel !== null
    && selectedProvider?.models.some((model) => model.id === currentModel) === true;
  const configured = currentProvider !== null && currentModel !== null && hasSelection;
  const version = VersionSchema.safeParse(status.version);
  // Legacy authKind defaults to OAuth for display compatibility. Exact source
  // evidence requires a unique raw provider with an explicit credential origin.
  const nativeProvider = nativeProviderRecord(options.providers, currentProvider);
  // Hermes's built-in openai-codex registry entry is OAuth-only. The installed
  // native model/options contract omits auth_type for this built-in entry.
  // Custom, duplicate, or explicitly different credential records stay closed.
  const selectedCredentialKind = nativeCredentialKind(currentProvider, nativeProvider);
  const codexProvider = nativeProviderRecord(options.providers, "openai-codex");
  const codexCredentialKind = nativeCredentialKind("openai-codex", codexProvider);
  const localObservation = (authenticated: boolean | undefined) => ({
    state: authenticated === true ? "present_unverified" as const
      : authenticated === false ? "absent" as const : "unknown" as const,
    checkedAt: new Date(input.observedAt!).toISOString(),
    staleAfter: new Date(input.observedAt! + 5_000).toISOString(),
  });

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
          ...(configured && selectedProvider && selectedCredentialKind && input.observedAt !== undefined ? {
            nativeRouteObservation: {
              providerId: currentProvider!, modelId: currentModel!,
              credentialKind: selectedCredentialKind,
              localObservation: localObservation(nativeProvider?.authenticated),
            },
          } : {}),
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
    ...(codexProvider && codexCredentialKind && input.observedAt !== undefined ? {
      nativeProfileObservations: [{ providerId: "openai-codex", credentialKind: codexCredentialKind,
        localObservation: localObservation(codexProvider.authenticated) }],
    } : {}),
    messaging: {
      runtime: "hermes",
      provider: configured ? currentProvider : null,
      model: configured ? currentModel : null,
      configured,
    },
    messagingObserved: true,
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
  let generation = 0;
  let inFlight: {
    generation: number;
    promise: Promise<AgentRuntimeSettingsSnapshot>;
  } | null = null;

  const source: AgentRuntimeSource = async (signal) => {
    signal.throwIfAborted();
    if (cached !== null && cached.expiresAt > now()) return cached.value;
    if (inFlight === null || inFlight.generation !== generation) {
      const requestGeneration = generation;
      const observedAt = now();
      const promise = Promise.allSettled([
        readJson("/api/status", signal),
        readJson("/api/model/options", signal),
      ]).then(([statusResult, modelOptionsResult]) => {
        signal.throwIfAborted();
        if (statusResult.status === "rejected") throw statusResult.reason;
        let modelOptions: unknown = { providers: [] };
        if (modelOptionsResult.status === "fulfilled") {
          modelOptions = modelOptionsResult.value;
        } else {
          logWarning(
            modelOptionsResult.reason instanceof Error
              ? modelOptionsResult.reason.name
              : "UnknownError",
          );
        }
        return normalizeHermesRuntimeSnapshot({
          status: statusResult.value,
          options: modelOptions,
          observedAt,
        });
      }).catch((err: unknown) => {
        logWarning(err instanceof Error ? err.name : "UnknownError");
        return unavailableHermesRuntimeSnapshot();
      }).then((value) => {
        if (requestGeneration === generation) {
          cached = { value, expiresAt: now() + cacheTtlMs };
        }
        return value;
      }).finally(() => {
        if (inFlight?.generation === requestGeneration) inFlight = null;
      });
      inFlight = { generation: requestGeneration, promise };
    }
    return inFlight.promise;
  };
  source.invalidate = () => {
    generation += 1;
    cached = null;
  };
  return source;
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
          selectionState: "action_required",
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
