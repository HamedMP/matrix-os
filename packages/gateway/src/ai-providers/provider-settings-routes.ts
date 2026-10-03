import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  ProviderDependencyCountsSchema,
  ProviderSettingsMutationSchema,
  type ProviderSettingsMutation,
  type ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import {
  ProviderSettingsStoreError,
  type ProviderSettingsStoreWriter,
} from "./provider-settings-store.js";

const PROVIDER_SETTINGS_BODY_LIMIT = 64 * 1024;
const RefreshQuerySchema = z.enum(["true", "false"]).optional();

function withCapabilities(snapshot: ProviderSettingsSnapshot, include: boolean, includeModels = false, includeInventory = false, includeFundingState = false, includeAccountDetails = false): ProviderSettingsSnapshot {
  const { matrixModelInventory, ...baseSnapshot } = snapshot;
  const publicSnapshot = { ...baseSnapshot, accounts: snapshot.accounts.map(({ connectionDetails, ...account }) => ({ ...account, ...(includeAccountDetails && connectionDetails ? { connectionDetails } : {}) })), ...(includeInventory && matrixModelInventory ? { matrixModelInventory } : {}), modelProviders: snapshot.modelProviders.map(provider => ({ ...provider, models: provider.models.map(({ capabilities, ...model }) => includeModels ? { ...model, ...(capabilities ? { capabilities } : {}) } : model) })), accessSources: snapshot.accessSources.map(source => source.readiness.safeReason === "credit_reserved" && !includeFundingState ? { ...source, readiness: { ...source.readiness, safeReason: "credit_required" as const } } : source), harnesses: snapshot.harnesses.map(({ enablementOrigin: _enablementOrigin, ...harness }) => harness) };
  if (include) return { ...publicSnapshot, atomicConnectSupported: snapshot.supportedActions.includes("set_route")
    && snapshot.supportedActions.includes("set_harness_enabled") };
  return {
    ...publicSnapshot,
    harnesses: publicSnapshot.harnesses.map(({ configuredEnabled: _configuredEnabled, configuredAccessSourceId: _configuredAccessSourceId, localObservation: _localObservation, ...harness }) => harness),
    accessSources: publicSnapshot.accessSources.map(({ localObservation: _localObservation, ...source }) => source),
  };
}
const DeleteAccountBodySchema = z.object({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  dependencyGuard: ProviderDependencyCountsSchema,
  confirmation: z.literal("remove_account"),
}).strict();

export interface ProviderSettingsRouteOptions {
  store: ProviderSettingsStoreWriter;
  canReadNativeAccountMetadata?: (context: Context) => boolean;
  getPrincipal: (context: Context) => unknown;
}

function bodyTooLarge(context: Context) {
  return context.json({
    error: { code: "body_too_large", message: "Request body is too large." },
  }, 413);
}

function invalidRequest(context: Context) {
  return context.json({
    error: { code: "invalid_request", message: "Invalid provider settings request." },
  }, 400);
}

function authorize(context: Context, options: ProviderSettingsRouteOptions): Response | null {
  try {
    const principal = options.getPrincipal(context);
    if (principal) return null;
  } catch (error) {
    console.warn(
      "[provider-settings] Request authentication failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
  return context.json({
    error: { code: "unauthorized", message: "Authentication is required." },
  }, 401);
}

async function readJson(context: Context): Promise<unknown> {
  try {
    return await context.req.json();
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) {
      console.warn(
        "[provider-settings] Failed to read request body:",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
    return undefined;
  }
}

function handleStoreError(context: Context, error: unknown) {
  if (error instanceof ProviderSettingsStoreError) {
    switch (error.code) {
      case "revision_conflict":
        return context.json({
          error: {
            code: "revision_conflict",
            message: "Provider settings changed. Refresh and try again.",
          },
          ...(error.latestRevision === undefined ? {} : { latestRevision: error.latestRevision }),
        }, 409);
      case "not_found":
        return context.json({
          error: { code: "not_found", message: "Provider settings item was not found." },
        }, 404);
      case "account_in_use":
        return context.json({
          error: {
            code: "account_in_use",
            message: "Reassign active chats before removing this account.",
          },
        }, 409);
      case "dependency_unavailable":
      case "lifecycle_unavailable":
      case "runtime_unavailable":
      case "configuration_unavailable":
      case "projection_unavailable":
        return context.json({
          error: {
            code: "provider_settings_unavailable",
            message: "Provider settings are unavailable.",
          },
        }, 503);
      case "invalid_request":
      case "invalid_route":
        return invalidRequest(context);
      case "idempotency_conflict":
        return context.json({
          error: {
            code: "idempotency_conflict",
            message: "This request key was already used for a different change.",
          },
        }, 409);
    }
  }
  console.warn(
    "[provider-settings] Provider settings request failed:",
    error instanceof Error ? error.name : "UnknownError",
  );
  return context.json({
    error: {
      code: "provider_settings_unavailable",
      message: "Provider settings are unavailable.",
    },
  }, 503);
}

export function createProviderSettingsRoutes(options: ProviderSettingsRouteOptions): Hono {
  if (!options.store) throw new Error("Provider settings store is required");
  if (!options.getPrincipal) throw new Error("Provider settings principal resolver is required");

  const app = new Hono();
  const mutationBodyLimit = bodyLimit({
    maxSize: PROVIDER_SETTINGS_BODY_LIMIT,
    onError: bodyTooLarge,
  });

  app.get("/provider-settings", async (context) => {
    const authError = authorize(context, options);
    if (authError) return authError;
    const refresh = RefreshQuerySchema.safeParse(context.req.query("refresh"));
    const accountDetails = RefreshQuerySchema.safeParse(context.req.query("includeAccountDetails"));
    const capabilities = RefreshQuerySchema.safeParse(context.req.query("includeCapabilities"));
    const modelCapabilities = RefreshQuerySchema.safeParse(context.req.query("includeModelCapabilities"));
    const fundingState = RefreshQuerySchema.safeParse(context.req.query("includeFundingState"));
    const inventory = RefreshQuerySchema.safeParse(context.req.query("includeMatrixModelInventory"));
    if (!accountDetails.success || !refresh.success || !capabilities.success || !modelCapabilities.success || !inventory.success || !fundingState.success) return invalidRequest(context);
    try {
      const ownerMetadata = options.canReadNativeAccountMetadata?.(context) === true;
      const snapshot = await options.store.getSnapshot({ refresh: refresh.data === "true", ...(ownerMetadata ? { includeNativeAccountMetadata: true } : {}) });
      if (options.canReadNativeAccountMetadata && !ownerMetadata) {
        snapshot.accessSources = snapshot.accessSources.map(source => source.id === "owner_openai_profile"
          || source.kind === "harness_profile" && source.harness === "hermes"
          ? { ...source, displayName: source.kind === "harness_profile" ? "Hermes account" : source.displayName,
              usage: { kind: "unavailable", authority: "unavailable", state: "unavailable", scope: "account", reason: "read_only", asOf: null } } : source);
        snapshot.accounts = snapshot.accounts.map(account => account.accessSourceId === "owner_openai_profile"
          ? { ...account, displayName: account.authMethod === "api_key" ? "API key" : "Codex account" } : account);
      }
      return context.json(withCapabilities(snapshot, capabilities.data === "true", modelCapabilities.data === "true", inventory.data === "true", fundingState.data === "true", ownerMetadata && accountDetails.data === "true"));
    } catch (error) {
      return handleStoreError(context, error);
    }
  });

  app.post("/provider-settings/actions", mutationBodyLimit, async (context) => {
    const authError = authorize(context, options);
    if (authError) return authError;
    const capabilities = RefreshQuerySchema.safeParse(context.req.query("includeCapabilities"));
    const modelCapabilities = RefreshQuerySchema.safeParse(context.req.query("includeModelCapabilities"));
    const fundingState = RefreshQuerySchema.safeParse(context.req.query("includeFundingState"));
    const inventory = RefreshQuerySchema.safeParse(context.req.query("includeMatrixModelInventory"));
    if (!capabilities.success || !modelCapabilities.success || !inventory.success || !fundingState.success) return invalidRequest(context);
    const mutation = ProviderSettingsMutationSchema.safeParse(await readJson(context));
    if (!mutation.success) return invalidRequest(context);
    try {
      const result = await options.store.mutate(mutation.data);
      return context.json({ ...result, snapshot: withCapabilities(result.snapshot, capabilities.data === "true", modelCapabilities.data === "true", inventory.data === "true", fundingState.data === "true") });
    } catch (error) {
      return handleStoreError(context, error);
    }
  });

  app.delete("/provider-settings/accounts/:accountId", mutationBodyLimit, async (context) => {
    const authError = authorize(context, options);
    if (authError) return authError;
    const capabilities = RefreshQuerySchema.safeParse(context.req.query("includeCapabilities"));
    const modelCapabilities = RefreshQuerySchema.safeParse(context.req.query("includeModelCapabilities"));
    const fundingState = RefreshQuerySchema.safeParse(context.req.query("includeFundingState"));
    const inventory = RefreshQuerySchema.safeParse(context.req.query("includeMatrixModelInventory"));
    if (!capabilities.success || !modelCapabilities.success || !inventory.success || !fundingState.success) return invalidRequest(context);
    const body = DeleteAccountBodySchema.safeParse(await readJson(context));
    if (!body.success) return invalidRequest(context);
    const mutation = ProviderSettingsMutationSchema.safeParse({
      type: "remove_account",
      expectedRevision: body.data.expectedRevision,
      idempotencyKey: body.data.idempotencyKey,
      accountId: context.req.param("accountId"),
      dependencyGuard: body.data.dependencyGuard,
      confirmation: body.data.confirmation,
    } satisfies ProviderSettingsMutation);
    if (!mutation.success) return invalidRequest(context);
    try {
      const result = await options.store.mutate(mutation.data);
      return context.json({ ...result, snapshot: withCapabilities(result.snapshot, capabilities.data === "true", modelCapabilities.data === "true", inventory.data === "true", fundingState.data === "true") });
    } catch (error) {
      return handleStoreError(context, error);
    }
  });

  return app;
}
