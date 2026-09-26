import type { ProviderSnapshotReadOptions } from "../ai-providers/snapshot-read-options.js";
import { JEV_MODEL_ID, FundedAiRuntimeFundingSummaryResponseSchema, type ChatAgent, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { createJevHermesCredentialResolver } from "../chat/jev-hermes-credentials.js";
import { verifyJevHermesRuntimePin, verifyJevHermesDependencies } from "../chat/jev-hermes-runtime-pin.js";
import { createFundedAiReadinessReader } from "../funded-ai-readiness.js";
import type { FundedAiFundingSummaryReader } from "../funded-ai-funding-summary-client.js";
import type { FundedAiRouteReadinessReader } from "../funded-ai-route-readiness-client.js";
import type { PlatformDb } from "../platform-db.js";
import type { PipedreamConnectClient } from "../integrations/pipedream.js";
import { createJevRecipeReadClient } from "./recipe-read-client.js";
import { createJevInboxRuntime } from "./inbox-runtime.js";
import { InboxPreviewError } from "./inbox-broker.js";
import type { JevService } from "./service.js";
import type { Context } from "hono";
import { resolveHermesJevScope } from "../chat/hermes-integration-capability.js";
import { getOptionalRequestPrincipal, isRequestPrincipalError } from "../request-principal.js";
import { createJevRoutes } from "./routes.js";

/** One production authority composition; no credential inheritance, transport fallback after failure, or alternate funding path. */
export function createProductionJevInboxRuntime(options: {
  homePath: string; ownerId: string; fundedOwnerId?: string;
  settings: { getSnapshot(options?: ProviderSnapshotReadOptions): Promise<ProviderSettingsSnapshot> };
  getAgent: (ownerId: string, agentId: string) => Promise<ChatAgent | null>;
  service: JevService | null;
  summary?: FundedAiFundingSummaryReader | null;
  routes?: FundedAiRouteReadinessReader;
  internalBaseUrl: string | null; machineToken?: string;
  db?: PlatformDb | null; pipedream?: PipedreamConnectClient | null;
}) {
  const readiness = options.summary && options.routes
    ? createFundedAiReadinessReader({ summary: options.summary, routes: {
      getRouteReadiness: call => options.routes!.getRouteReadiness({ ...call, modelId: JEV_MODEL_ID }),
    } }) : null;
  const read = createJevRecipeReadClient(options);
  const runtime = createJevInboxRuntime({ ownerId: options.ownerId, getAgent: options.getAgent,
    resolveCredentials: createJevHermesCredentialResolver(options),
    verifyRuntime: async (root, signal) => {
      await verifyJevHermesRuntimePin(root, signal);
      await verifyJevHermesDependencies(root, signal);
    },
    fundedPolicyReady: async signal => {
      if (!options.service || !options.fundedOwnerId || !options.summary) return false;
      const raw = await options.summary.getFundingSummary({ signal }); signal.throwIfAborted();
      const { policy, funding } = FundedAiRuntimeFundingSummaryResponseSchema.parse({ contractVersion: 1, ...raw });
      const now = Date.now();
      return policy.enabled && policy.allowedModelIds.includes(JEV_MODEL_ID)
        && Date.parse(policy.checkedAt) <= now && Date.parse(policy.staleAfter) > now
        && funding.remainingBudgetMicrousd > 0 && funding.remainingBalanceMicrousd > 0
        && Date.parse(funding.asOf) <= now + 60_000 && now - Date.parse(funding.asOf) < 300_000;
    },
    fundedReady: async signal => {
      signal.throwIfAborted();
      if (!options.service || !options.fundedOwnerId || !readiness) return false;
      if (!(options.internalBaseUrl && options.machineToken) && !(options.db && options.pipedream)) return false;
      const result = await readiness.read({ signal }); signal.throwIfAborted();
      return result.readiness.state === "ready" && result.allowedModelIds.includes(JEV_MODEL_ID);
    },
    read,
    evaluate: async (owner, input, signal) => {
      if (owner !== options.ownerId || !options.service || !options.fundedOwnerId) throw new InboxPreviewError("denied");
      return options.service.evaluate(options.fundedOwnerId, input, signal);
    },
  });
  function resolveRecipeScope(context: Context) {
    const token = /^Bearer ([a-f0-9]{64})$/i.exec(context.req.header("authorization") ?? "")?.[1];
    const binding = token ? resolveHermesJevScope(token) : null;
    if (!binding || binding.ownerId !== options.ownerId) return null;
    try {
      const principal = getOptionalRequestPrincipal(context);
      return principal?.userId === binding.ownerId ? binding : null;
    } catch (error) {
      if (!isRequestPrincipalError(error)) throw error;
      console.warn("[jev] Recipe principal unavailable", { errorName: error.name });
      return null;
    }
  }
  return { ...runtime, resolveRecipeScope, routes: createJevRoutes({ service: options.service,
    inboxBroker: runtime.broker, resolveRecipeScope,
    resolveOwnerId(context) {
      const principal = getOptionalRequestPrincipal(context);
      return options.fundedOwnerId && (principal?.userId === options.ownerId || principal?.userId === options.fundedOwnerId)
        ? options.fundedOwnerId : null;
    },
  }) };
}
