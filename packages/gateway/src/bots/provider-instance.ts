import { MANAGED_PI_INSTANCE_ID } from "./route-resolver.js";
/**
 * The `matrix_bot` provider instance (spec 536). It is added only to the
 * catalog the chat orchestrator admits turns against, never to the catalog
 * served to clients, so it cannot appear in a model picker. Turns reach it
 * only through a bot's own chat, where the agent context selects it; any
 * other chat that asks for it is refused before admission.
 */
import type {
  CanonicalChatModelSelection,
  CanonicalProviderCatalog,
  CanonicalProviderDriverDescriptor,
  CanonicalProviderInstanceDescriptor,
} from "@matrix-os/contracts";
import type { ChatProviderCatalogService } from "../chat/provider-catalog.js";
import type { RequestPrincipal } from "../request-principal.js";
import { MATRIX_BOT_INSTANCE_ID, MATRIX_BOT_MODEL } from "./selection.js";

export const MATRIX_BOT_DRIVER: CanonicalProviderDriverDescriptor = {
  kind: "matrix_bot",
  displayName: "Matrix bot",
  adapterVersion: "1.0.0",
  capabilityClass: "system_agent",
};

function botInstance(catalogRevision: string, model = MATRIX_BOT_MODEL): CanonicalProviderInstanceDescriptor {
  return {
    id: MATRIX_BOT_INSTANCE_ID,
    driverKind: "matrix_bot",
    displayName: "Matrix bot",
    availability: "available",
    workspaceRequirement: "none",
    catalogRevision,
    // The concrete model is resolved from Provider V3 when each run starts.
    models: [{
      id: model, displayName: model === MATRIX_BOT_MODEL ? "Automatic" : model, availability: "available",
      capabilities: ["tools"], supportsVision: false, supportsToolUse: true,
    }],
    options: [],
    skills: [],
    commands: [],
    setupActions: [],
    supports: {
      rootChat: true, resume: false, cancellation: true, steering: "same_run",
      attachments: [], tools: [], approvals: false, userInput: false, worktrees: "none",
      resources: [], interactionModes: ["default"], permissionModes: ["default"],
    },
    defaultSelection: { instanceId: MATRIX_BOT_INSTANCE_ID, model },
  };
}

/** The orchestrator's admission catalog: the served catalog plus the bot instance. */
export function withBotProviderInstance(
  catalog: Pick<ChatProviderCatalogService, "getCatalog">,
): Pick<ChatProviderCatalogService, "getCatalog"> {
  return {
    async getCatalog(principal: RequestPrincipal, selection?: CanonicalChatModelSelection): Promise<CanonicalProviderCatalog> {
      // Admission passes the server-prepared selection only after owner/bot Chat
      // checks. Bot routing reads Provider V3 at dispatch, not ordinary harness settings.
      if (selection?.instanceId === MATRIX_BOT_INSTANCE_ID) {
        if (selection.model !== MATRIX_BOT_MODEL) {
          if (selection.options?.length) {
            const base = await catalog.getCatalog(principal, { ...selection, instanceId: "matrix_chatgpt_plan" });
            const plan = base.instances.find(instance => instance.id === "matrix_chatgpt_plan");
            if (plan) {
              const instance = { ...plan, id: MATRIX_BOT_INSTANCE_ID, supports: { ...plan.supports, rootChat: true },
                ...(plan.defaultSelection ? { defaultSelection: { ...plan.defaultSelection, instanceId: MATRIX_BOT_INSTANCE_ID } } : {}) };
              return { revision: base.revision, drivers: [MATRIX_BOT_DRIVER], instances: [instance] };
            }
            const instance = botInstance(base.revision, selection.model);
            instance.availability = "unavailable"; instance.models = []; delete instance.defaultSelection;
            return { revision: base.revision, drivers: [MATRIX_BOT_DRIVER], instances: [instance] };
          }
          const base = await catalog.getCatalog(principal, { ...selection, instanceId: MANAGED_PI_INSTANCE_ID });
          const managed = base.instances.find((instance) => instance.id === "matrix_pi_default");
          const chosen = managed?.models.find((model) => model.id === selection.model && model.availability === "available");
          const instance = botInstance(base.revision, selection.model);
          if (!chosen || managed?.availability !== "available" || Object.keys(selection.options ?? {}).length) {
            instance.availability = "unavailable"; instance.models = []; delete instance.defaultSelection;
          }
          return { revision: base.revision, drivers: [MATRIX_BOT_DRIVER], instances: [instance] };
        }
        const revision = "matrix_bot_v1";
        return { revision, drivers: [MATRIX_BOT_DRIVER], instances: [botInstance(revision)] };
      }
      const base = selection ? await catalog.getCatalog(principal, selection) : await catalog.getCatalog(principal);
      if (base.instances.some((instance) => instance.id === MATRIX_BOT_INSTANCE_ID)) return base;
      return {
        ...base,
        drivers: base.drivers.some((driver) => driver.kind === "matrix_bot") ? base.drivers : [...base.drivers, MATRIX_BOT_DRIVER],
        instances: [...base.instances, botInstance(base.revision)],
      };
    },
  };
}
