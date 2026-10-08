/**
 * Provider readiness for shared Chat runs, extracted from shared-ai-runtime.ts
 * so that composition file stays under the large-file limit. Behavior is
 * unchanged.
 */
import type { CanonicalChatModelSelection, CanonicalProviderDriverKind } from "@matrix-os/contracts";
import { validateChatProviderSelection, type ChatProviderCatalogService } from "../chat/provider-catalog.js";
import type { CodingAgentProviderRegistry } from "../coding-agents/provider-registry.js";
import type { KernelCredentialObservationState, KernelCredentialSources } from "../kernel-credentials.js";

export const SHARED_RUN_SELECTION_REQUIREMENTS = { interactionMode: "default", permissionMode: "supervised" } as const;

export type SharedProviderReadiness = "ready" | "reconnect_required" | "unavailable";

interface SharedProviderReadinessInput {
  resolveCredentialSources(): Promise<KernelCredentialSources>;
  codingProviders?: Pick<CodingAgentProviderRegistry, "listProviders">;
  providerCatalog?: Pick<ChatProviderCatalogService, "getCatalog">;
}

/**
 * Readiness follows the immutable bound driver, never an Instance id: the
 * catalog does not reserve ids per driver, so a Claude binding may legitimately
 * use any Instance id. An unbound Chat has no bound driver yet, so its candidate
 * selection is classified through the trusted server-side catalog (a `codex`
 * Instance takes the Codex route); without a catalog it follows the Claude
 * default, and first-binding authority still requires a catalog to bind.
 */
export async function resolveSharedProviderReadiness(
  input: SharedProviderReadinessInput,
  ownerId: string,
  selection?: CanonicalChatModelSelection | null,
  boundDriverKind?: CanonicalProviderDriverKind | null,
): Promise<SharedProviderReadiness> {
  if (boundDriverKind === "codex") {
    return selection ? resolveCodexProviderReadiness(input, ownerId, selection) : "unavailable";
  }
  if (boundDriverKind || !input.providerCatalog || !selection) {
    return resolveClaudeProviderReadiness(input, ownerId, selection);
  }
  const catalog = await input.providerCatalog.getCatalog({ userId: ownerId, source: "jwt" });
  const cached = { getCatalog: async () => catalog };
  const candidate = catalog.instances.find((instance) => instance.id === selection.instanceId);
  return candidate?.driverKind === "codex"
    ? resolveCodexProviderReadiness({ providerCatalog: cached }, ownerId, selection)
    : resolveClaudeProviderReadiness({ ...input, providerCatalog: cached }, ownerId, selection);
}

/**
 * Codex owner identity lives in the owner's Codex auth file and is refreshed by
 * the scope broker at inference time, so readiness is verified only through the
 * trusted server-side provider catalog. Without a catalog it fails closed. An
 * unauthenticated Codex Instance reports generic unavailability: the owner
 * reconnect guidance names Claude credentials and must not be shown for Codex.
 */
async function resolveCodexProviderReadiness(
  input: Pick<SharedProviderReadinessInput, "providerCatalog">,
  ownerId: string,
  selection: CanonicalChatModelSelection,
): Promise<SharedProviderReadiness> {
  if (!input.providerCatalog) return "unavailable";
  const catalog = await input.providerCatalog.getCatalog({ userId: ownerId, source: "jwt" });
  const validated = validateChatProviderSelection({
    catalog,
    selection,
    requirements: SHARED_RUN_SELECTION_REQUIREMENTS,
  });
  return validated.ok && validated.instance.driverKind === "codex" ? "ready" : "unavailable";
}

/**
 * Readiness follows the kernel credential access source the scoped run will
 * actually use (see `scope-runtime-broker`): Matrix-included access, the owner's
 * API key, or the owner's Claude profile. Matrix-included access is platform
 * managed and needs no probe. Owner routes are never ready on credential material
 * alone: the trusted server-side provider catalog must validate the complete
 * bound selection (Instance, model, options, shared-run requirements), and an
 * `authentication_required` Instance maps to reconnect guidance. Without a
 * catalog, the owner-profile route falls back to the Claude login state and the
 * owner API key route fails closed.
 */
export async function resolveClaudeProviderReadiness(
  input: SharedProviderReadinessInput,
  ownerId: string,
  selection?: CanonicalChatModelSelection | null,
): Promise<SharedProviderReadiness> {
  const sources = await input.resolveCredentialSources();
  if (sources.selectedAccessSourceId === "matrix_included") {
    return sources.matrixIncluded.state === "ready" ? "ready" : "unavailable";
  }
  const observed = sources.selectedAccessSourceId === "owner_anthropic_key"
    ? sources.ownerApiKey.state
    : sources.ownerProfile.state;
  if (!usableCredentialState(observed)) return "unavailable";
  if (input.providerCatalog && selection) {
    // Validate the complete canonical selection (Instance, model, options, and
    // shared-run requirements) exactly as the first-binding path does, so a
    // removed or disabled model never reports ready.
    const catalog = await input.providerCatalog.getCatalog({ userId: ownerId, source: "jwt" });
    const validated = validateChatProviderSelection({
      catalog,
      selection,
      requirements: SHARED_RUN_SELECTION_REQUIREMENTS,
    });
    if (validated.ok) return validated.instance.driverKind === "claude_code" ? "ready" : "unavailable";
    const instance = catalog.instances.find((candidate) => candidate.id === selection.instanceId);
    return instance?.driverKind === "claude_code" && instance.unavailabilityReason === "authentication_required"
      ? "reconnect_required"
      : "unavailable";
  }
  if (sources.selectedAccessSourceId === "owner_anthropic_profile" && input.codingProviders) {
    const summaries = await input.codingProviders.listProviders({ userId: ownerId, source: "jwt" });
    const claude = summaries.find((provider) => provider.id === "claude" || provider.kind === "claude");
    if (claude?.availability === "available" && claude.authStatus === "authenticated") return "ready";
    if (claude?.availability === "auth_required" || claude?.authStatus === "expired") {
      return "reconnect_required";
    }
  }
  return "unavailable";
}

function usableCredentialState(state: KernelCredentialObservationState): boolean {
  return state === "ready" || state === "unverified";
}
