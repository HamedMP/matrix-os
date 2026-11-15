import { CanonicalChatModelSelectionSchema, type CanonicalChatModelSelection, type CanonicalProviderDriverKind } from "@matrix-os/contracts";
import { validateChatProviderSelection, type ChatProviderCatalogService } from "../chat/provider-catalog.js";
import type { CanonicalSharedProviderAuthority } from "../chat/repository.js";
import { CODEX_SHARED_INSTANCE_ID, sharedAiAdapterFor, sharedAiEligibilitySupportsDriver, type CollaborationAiExecutionEligibility } from "./shared-ai-eligibility.js";
import { SHARED_RUN_SELECTION_REQUIREMENTS } from "./shared-provider-readiness.js";
import type { SharedRunOwnerSource, SharedRunOwnerSourceDecision } from "./shared-run-owner-source.js";
import type { SharedMatrixBotExtension } from "./shared-matrix-bot.js";
import { MATRIX_BOT_INSTANCE_ID, MATRIX_BOT_MODEL } from "../bots/selection.js";

const CLAUDE_CHAT_INSTANCE_ID = "claude_code_default";

/** Resolve current owner authority and validate the executable selection without creating a run. */
export function createSharedProviderAuthorityResolver(options: {
  ownerSource: Pick<SharedRunOwnerSource, "authority">;
  providerCatalog?: Pick<ChatProviderCatalogService, "getCatalog">;
  matrixBot?: Pick<SharedMatrixBotExtension, "readiness">;
  eligibility: CollaborationAiExecutionEligibility;
}) {
  const { eligibility } = options;
  return async (
    scopeId: string,
    ownerId: string,
    selection: CanonicalChatModelSelection | null,
    boundDriverKind: CanonicalProviderDriverKind | null,
  ): Promise<CanonicalSharedProviderAuthority | null> => {
    const decision = await options.ownerSource.authority({ scopeId, ownerId });
    if (selection?.instanceId === MATRIX_BOT_INSTANCE_ID) {
      if (boundDriverKind !== null && boundDriverKind !== "matrix_bot") return null;
      if (!options.matrixBot || selection.model !== MATRIX_BOT_MODEL
        || !sharedAiEligibilitySupportsDriver(eligibility, "matrix_bot", MATRIX_BOT_INSTANCE_ID)
        || await options.matrixBot.readiness?.(ownerId, selection, decision) !== "ready") return null;
      return { driverKind: "matrix_bot" as const, selection };
    }
    const driverKind = decision.harness === "codex" ? "codex" as const : "claude_code" as const;
    if (boundDriverKind !== null && boundDriverKind !== driverKind) return null;
    const currentSelection = canonicalChatSelectionForOwnerAuthority(decision, selection);
    if (!currentSelection) return null;
    if (!options.providerCatalog) return null;
    const catalogSelection = catalogChatSelectionForOwnerAuthority(decision, currentSelection);
    const catalog = await options.providerCatalog.getCatalog({ userId: ownerId, source: "jwt" }, catalogSelection);
    const validated = validateChatProviderSelection({
      catalog,
      selection: catalogSelection,
      requirements: SHARED_RUN_SELECTION_REQUIREMENTS,
    });
    if (!validated.ok || (validated.instance.driverKind !== driverKind
      && !(driverKind === "claude_code" && validated.instance.driverKind === "kernel"))) return null;
    // The owner's first binding may only name a driver this runtime can
    // execute in isolation; the queue re-verifies the signed eligibility.
    const adapterId = sharedAiAdapterFor(driverKind, currentSelection.instanceId);
    if (!adapterId || !eligibility.adapters.some((adapter) => adapter.adapterId === adapterId)) {
      return null;
    }
    return {
      driverKind,
      selection: currentSelection,
      ...(decision.authorityKind === "provider_settings_active" ? {
        currentOwnerRoute: true as const,
        providerAccessSourceId: decision.providerAccessSourceId,
        routeGeneration: decision.routeGeneration,
      } : {}),
    };
  };
}

/**
 * Provider Settings instance IDs identify saved route provenance, while the
 * Chat catalog identifies executable harness instances. Keep the former on
 * the immutable run binding and translate only the dispatch selection.
 */
export function executableChatSelectionForOwnerRoute(
  decision: Pick<SharedRunOwnerSourceDecision, "harness" | "modelId">,
): CanonicalChatModelSelection {
  return CanonicalChatModelSelectionSchema.parse({
    instanceId: decision.harness === "codex" ? CODEX_SHARED_INSTANCE_ID : CLAUDE_CHAT_INSTANCE_ID,
    model: decision.modelId,
  });
}

export function canonicalChatSelectionForOwnerAuthority(
  decision: SharedRunOwnerSourceDecision,
  selection: CanonicalChatModelSelection | null,
): CanonicalChatModelSelection | null {
  return decision.authorityKind === "provider_settings_active"
    ? executableChatSelectionForOwnerRoute(decision)
    : selection === null
      ? null
      : CanonicalChatModelSelectionSchema.parse({ ...selection, model: decision.modelId });
}

/**
 * Standalone Chats retain their immutable shared-run binding, whose instance
 * ID identifies the isolated adapter rather than a provider-catalog entry.
 * Translate only the catalog lookup; the caller still returns and persists the
 * original binding selection.
 */
export function catalogChatSelectionForOwnerAuthority(
  decision: SharedRunOwnerSourceDecision,
  selection: CanonicalChatModelSelection,
): CanonicalChatModelSelection {
  return decision.authorityKind === "standalone_policy"
    ? executableChatSelectionForOwnerRoute(decision)
    : selection;
}

