import {
  AgentMessagingSelectionSchema,
  AgentProviderCatalogSchema,
  AgentRuntimeDescriptorSchema,
  type AgentAuthKind,
  type AgentMessagingSelection,
  type AgentProviderDescriptor,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { AgentConfigError } from "./errors.js";
import type { OpenClawRpcClient } from "./openclaw-rpc.js";
import type {
  MessagingRuntimeAdapter,
  RuntimeConfigureInput,
} from "./runtime-types.js";

const MAX_OPENCLAW_PROVIDERS = 31;
const MAX_OPENCLAW_MODELS = 253;
const MAX_MODELS_PER_PROVIDER = 128;

const ProviderIdSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
const ModelIdSchema = z.string().trim().min(1).max(160);
const DisplayNameSchema = z.string().trim().min(1).max(120);

const HostStatusSchema = z.object({
  installed: z.boolean(),
  active: z.boolean(),
  version: z.string().trim().min(1).max(64).optional(),
}).strict();

const ModelChoiceSchema = z.object({
  id: ModelIdSchema,
  name: DisplayNameSchema,
  provider: ProviderIdSchema,
  alias: z.string().trim().min(1).max(160).optional(),
  available: z.boolean().optional(),
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  reasoning: z.boolean().optional(),
}).strict();
const ModelsListSchema = z.object({
  models: z.array(ModelChoiceSchema).max(2_048),
}).strict();

const AuthProfileSchema = z.object({
  profileId: z.string().min(1).max(256),
  type: z.string().min(1).max(32),
  status: z.string().min(1).max(32),
}).passthrough();
const AuthProviderSchema = z.object({
  provider: ProviderIdSchema,
  displayName: DisplayNameSchema.optional(),
  status: z.string().min(1).max(32),
  profiles: z.array(AuthProfileSchema).max(128),
}).passthrough();
const AuthStatusSchema = z.object({
  ts: z.number().finite(),
  providers: z.array(AuthProviderSchema).max(256),
}).strict();

const ConfigSnapshotSchema = z.object({
  valid: z.literal(true),
  hash: z.string().min(1).max(256),
  config: z.object({
    agents: z.object({
      defaults: z.object({
        model: z.object({
          primary: z.string().trim().min(1).max(241).optional(),
        }).passthrough().optional(),
      }).passthrough().optional(),
    }).passthrough().optional(),
  }).passthrough(),
}).passthrough();
const MutationResponseSchema = z.object({ ok: z.literal(true) }).passthrough();
const HealthResponseSchema = z.object({
  ts: z.number().finite().optional(),
}).passthrough();

export interface OpenClawLifecycle {
  status(signal: AbortSignal): Promise<unknown>;
  activate(signal: AbortSignal): Promise<void>;
  deactivate(signal: AbortSignal): Promise<void>;
}

interface ConfigSelection {
  hash: string;
  primary: string | null;
  selection: AgentMessagingSelection;
}

function parsePrimary(primary: string | undefined): AgentMessagingSelection {
  if (primary === undefined) {
    return { runtime: "openclaw", provider: null, model: null, configured: false };
  }
  const separator = primary.indexOf("/");
  if (separator <= 0 || separator === primary.length - 1) {
    throw new AgentConfigError("invalid_response");
  }
  const provider = ProviderIdSchema.safeParse(primary.slice(0, separator));
  const model = ModelIdSchema.safeParse(primary.slice(separator + 1));
  if (!provider.success || !model.success) {
    throw new AgentConfigError("invalid_response");
  }
  return AgentMessagingSelectionSchema.parse({
    runtime: "openclaw",
    provider: provider.data,
    model: model.data,
    configured: true,
  });
}

function authKindForProvider(profiles: z.infer<typeof AuthProfileSchema>[]): AgentAuthKind {
  if (profiles.some((profile) => profile.type === "oauth")) return "oauth_login";
  return "api_key";
}

function actionForAuth(authKind: AgentAuthKind) {
  return authKind === "oauth_login"
    ? "open_login_terminal" as const
    : "enter_api_key" as const;
}

function authReady(status: string): boolean {
  return status === "ok" || status === "static";
}

function normalizeCatalog(
  modelResponse: unknown,
  authResponse: unknown,
): AgentProviderDescriptor[] {
  const models = ModelsListSchema.parse(modelResponse).models;
  const authProviders = AuthStatusSchema.parse(authResponse).providers;
  const authByProvider = new Map(authProviders.map((provider) => [provider.provider, provider]));
  const grouped = new Map<string, z.infer<typeof ModelChoiceSchema>[]>();
  for (const model of models) {
    const entries = grouped.get(model.provider) ?? [];
    const duplicateIndex = entries.findIndex((entry) => entry.id === model.id);
    if (duplicateIndex === -1 && entries.length < MAX_MODELS_PER_PROVIDER) {
      entries.push(model);
    } else if (duplicateIndex !== -1
      && entries[duplicateIndex]?.available !== true
      && model.available === true) {
      entries[duplicateIndex] = model;
    }
    grouped.set(model.provider, entries);
  }

  const providers: AgentProviderDescriptor[] = [];
  let modelCount = 0;
  for (const [id, entries] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    if (providers.length === MAX_OPENCLAW_PROVIDERS || modelCount === MAX_OPENCLAW_MODELS) break;
    const auth = authByProvider.get(id);
    const authKind = authKindForProvider(auth?.profiles ?? []);
    const ready = auth === undefined
      ? entries.some((model) => model.available === true)
      : authReady(auth.status);
    const remaining = MAX_OPENCLAW_MODELS - modelCount;
    const normalizedModels = entries.slice(0, remaining).map((model) => ({
      id: model.id,
      displayName: model.name,
      capabilities: [
        "tools" as const,
        ...(model.reasoning === true ? ["reasoning" as const] : []),
        ...(model.contextWindow !== undefined && model.contextWindow >= 100_000
          ? ["long_context" as const]
          : []),
      ],
      efforts: [],
      available: model.available === true,
    }));
    const displayName = DisplayNameSchema.safeParse(auth?.displayName);
    providers.push({
      id,
      displayName: displayName.success ? displayName.data : id,
      runtime: "openclaw",
      scopes: ["messaging"],
      authKind,
      supportedAuthKinds: [authKind],
      models: normalizedModels,
      authStatus: ready
        ? { state: "ready", authenticated: true, action: "none" }
        : {
            state: "action_required",
            authenticated: false,
            action: actionForAuth(authKind),
          },
    });
    modelCount += normalizedModels.length;
  }
  return AgentProviderCatalogSchema.parse(providers);
}

function primaryPatch(primary: string | null) {
  return {
    raw: JSON.stringify({ agents: { defaults: { model: { primary } } } }),
  };
}

export function createOpenClawRuntimeAdapter(options: {
  rpc: OpenClawRpcClient;
  lifecycle: OpenClawLifecycle;
}): MessagingRuntimeAdapter {
  async function readConfig(
    signal: AbortSignal,
    tolerateMalformedPrimary = false,
  ): Promise<ConfigSelection> {
    const snapshot = ConfigSnapshotSchema.parse(
      await options.rpc.call("config.get", {}, signal),
    );
    const primary = snapshot.config.agents?.defaults?.model?.primary ?? null;
    let selection: AgentMessagingSelection;
    try {
      selection = parsePrimary(primary ?? undefined);
    } catch (error) {
      if (!tolerateMalformedPrimary || !(error instanceof AgentConfigError)) throw error;
      selection = {
        runtime: "openclaw",
        provider: null,
        model: null,
        configured: false,
      };
    }
    return {
      hash: snapshot.hash,
      primary,
      selection,
    };
  }

  async function patchPrimary(
    primary: string | null,
    baseHash: string,
    signal: AbortSignal,
  ): Promise<void> {
    MutationResponseSchema.parse(await options.rpc.call("config.patch", {
      ...primaryPatch(primary),
      baseHash,
    }, signal));
  }

  async function restorePrimary(previous: string | null): Promise<void> {
    const signal = AbortSignal.timeout(2_000);
    try {
      const current = await readConfig(signal);
      await patchPrimary(previous, current.hash, signal);
    } catch (error) {
      console.warn(
        "[agent-config] OpenClaw selection restore failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
  }

  async function catalog(signal: AbortSignal) {
    const modelResponse = await options.rpc.call("models.list", { view: "all" }, signal);
    const authResponse = await options.rpc.call(
      "models.authStatus",
      { refresh: false },
      signal,
    );
    return normalizeCatalog(modelResponse, authResponse);
  }

  async function configure(
    input: RuntimeConfigureInput,
    signal: AbortSignal,
  ): Promise<AgentMessagingSelection> {
    if (input.baseUrl !== undefined) throw new AgentConfigError("not_configured");
    const providers = await catalog(signal);
    const provider = providers.find((entry) => entry.id === input.provider);
    if (provider?.models.some((model) =>
      model.id === input.model && model.available
    ) !== true) {
      throw new AgentConfigError("not_configured");
    }
    const previous = await readConfig(signal);
    const primary = `${input.provider}/${input.model}`;
    try {
      // A transport failure can occur after OpenClaw accepted the patch but
      // before Matrix received the response. Keep the write inside the
      // restore boundary so an unknown outcome is treated like a mismatch.
      await patchPrimary(primary, previous.hash, signal);
      const verified = await readConfig(signal);
      if (verified.primary !== primary) throw new AgentConfigError("invalid_response");
      return verified.selection;
    } catch (error) {
      await restorePrimary(previous.primary);
      if (error instanceof AgentConfigError) throw error;
      throw new AgentConfigError("invalid_response", error);
    }
  }

  return {
    id: "openclaw",
    async probe(signal) {
      const host = HostStatusSchema.parse(await options.lifecycle.status(signal));
      if (!host.installed) {
        return AgentRuntimeDescriptorSchema.parse({
          id: "openclaw",
          displayName: "OpenClaw",
          installState: "missing",
          health: "stopped",
          selectionState: "unavailable",
          configured: false,
          capabilities: ["install"],
          setupAction: "install",
        });
      }
      if (!host.active) {
        return AgentRuntimeDescriptorSchema.parse({
          id: "openclaw",
          displayName: "OpenClaw",
          installState: "installed",
          health: "stopped",
          selectionState: "available",
          configured: false,
          ...(host.version === undefined ? {} : { version: host.version }),
          capabilities: ["provider_catalog", "model_selection", "authentication"],
        });
      }
      HealthResponseSchema.parse(await options.rpc.call("health", {}, signal));
      const current = await readConfig(signal, true);
      return AgentRuntimeDescriptorSchema.parse({
        id: "openclaw",
        displayName: "OpenClaw",
        installState: "installed",
        health: "healthy",
        selectionState: "active",
        configured: current.selection.configured,
        ...(host.version === undefined ? {} : { version: host.version }),
        capabilities: ["provider_catalog", "model_selection", "authentication"],
      });
    },
    catalog,
    async selection(signal) {
      return (await readConfig(signal)).selection;
    },
    configure,
    async prepare(signal) {
      const host = HostStatusSchema.parse(await options.lifecycle.status(signal));
      if (!host.installed) throw new AgentConfigError("runtime_unavailable");
    },
    async activate(signal) {
      await options.lifecycle.activate(signal);
    },
    async deactivate(signal) {
      await options.lifecycle.deactivate(signal);
    },
    async dashboard() {
      return null;
    },
    async close() {
      await options.rpc.close();
    },
  };
}
