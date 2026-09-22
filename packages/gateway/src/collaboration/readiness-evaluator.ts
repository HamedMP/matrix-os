/**
 * S04 / T023: readiness evaluator for a shareable resource on the home computer.
 *
 * The evaluator is pure over injected probes so that S08 (owner AI source and
 * submit mode), S10 (Git identity, forge credential, Chat root inventory) and
 * the transport layer (host reachability) can supply real sources without a
 * second readiness model. Every probe failure degrades to the safe value:
 * an unreadable item is `unavailable`, an unknown submit mode is
 * `owner_only`, and an unsupported type reports `unsupported`.
 */
import {
  CollaborationReadinessSchema,
  readinessItemsForResourceKind,
  type CollaborationOwnerSetupItem,
  type CollaborationReadiness,
  type CollaborationReadinessItem,
  type CollaborationResourceKind,
  type CollaborationSourceKind,
} from "@matrix-os/contracts";

export interface ReadinessSubject {
  resourceKind: CollaborationResourceKind;
  ownerId: string;
  scopeId: string;
  organizationId: string;
}

export interface OwnerSetupProbeResult {
  configured: boolean;
  label?: string;
}

export interface AiSourceProbeResult {
  configured: boolean;
  sourceKind?: CollaborationSourceKind;
}

export interface ChatRootInventoryProbeResult {
  chatRootCount: number;
  dirtyRootCount: number;
  /** Roots that could not be resolved; any unresolved root blocks the share. */
  unresolved: number;
}

export interface ReadinessProbes {
  hostOnline(subject: ReadinessSubject): Promise<boolean>;
  supported(subject: ReadinessSubject): Promise<boolean>;
  gitIdentity(subject: ReadinessSubject): Promise<OwnerSetupProbeResult>;
  forgeCredential(subject: ReadinessSubject): Promise<OwnerSetupProbeResult>;
  aiSource(subject: ReadinessSubject): Promise<AiSourceProbeResult>;
  submitMode(subject: ReadinessSubject): Promise<"members" | "owner_only">;
  chatRootInventory(subject: ReadinessSubject): Promise<ChatRootInventoryProbeResult>;
}

async function probe<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error: unknown) {
    console.warn("[collaboration-readiness] probe failed", name, error instanceof Error ? error.name : "UnknownError");
    return undefined;
  }
}

function unavailableItems(kind: CollaborationResourceKind): CollaborationReadinessItem[] {
  return readinessItemsForResourceKind(kind).map((item) => ({ item, status: "unavailable" as const }));
}

export async function evaluateCollaborationReadiness(
  subject: ReadinessSubject,
  probes: ReadinessProbes,
): Promise<CollaborationReadiness> {
  const supported = await probe("supported", () => probes.supported(subject));
  if (supported !== true) {
    return CollaborationReadinessSchema.parse({
      resourceKind: subject.resourceKind, state: "unsupported", missingOwnerSetup: [], items: unavailableItems(subject.resourceKind),
    });
  }
  const online = await probe("hostOnline", () => probes.hostOnline(subject));
  if (online !== true) {
    return CollaborationReadinessSchema.parse({
      resourceKind: subject.resourceKind, state: "host_offline", missingOwnerSetup: [], items: unavailableItems(subject.resourceKind),
    });
  }
  if (readinessItemsForResourceKind(subject.resourceKind).length === 0) {
    return CollaborationReadinessSchema.parse({
      resourceKind: subject.resourceKind, state: "ready", missingOwnerSetup: [], items: [],
    });
  }

  const [aiSource, submitMode, gitIdentity, forgeCredential, inventory] = await Promise.all([
    probe("aiSource", () => probes.aiSource(subject)),
    probe("submitMode", () => probes.submitMode(subject)),
    probe("gitIdentity", () => probes.gitIdentity(subject)),
    probe("forgeCredential", () => probes.forgeCredential(subject)),
    probe("chatRootInventory", () => probes.chatRootInventory(subject)),
  ]);

  // State derives from the three owner setup items. An unresolved Chat root or an unknown
  // submit mode is reported through the item status (and the fail-closed owner-only mode);
  // the share preflight blocks on an unavailable inventory item with its own explanation.
  const missing: CollaborationOwnerSetupItem[] = [];
  if (!gitIdentity?.configured) missing.push("git_identity");
  if (!forgeCredential?.configured) missing.push("forge_credential");
  if (!aiSource?.configured || !aiSource.sourceKind) missing.push("ai_source");
  const inventoryBlocked = inventory === undefined || inventory.unresolved > 0;
  const items: CollaborationReadinessItem[] = [
    { item: "ai_source", status: aiSource === undefined ? "unavailable" : aiSource.configured ? "ready" : "missing" },
    { item: "submit_mode", status: submitMode === undefined ? "unavailable" : "ready" },
    {
      item: "git_identity",
      status: gitIdentity === undefined ? "unavailable" : gitIdentity.configured ? "ready" : "missing",
      ...(gitIdentity?.configured && gitIdentity.label ? { identityLabel: gitIdentity.label } : {}),
    },
    {
      item: "chat_root_inventory",
      status: inventoryBlocked ? "unavailable" : "ready",
      ...(inventory ? { chatRootCount: inventory.chatRootCount, dirtyRootCount: inventory.dirtyRootCount } : {}),
    },
  ];
  const state = missing.length > 0 ? "owner_setup_needed" : "ready";
  return CollaborationReadinessSchema.parse({
    resourceKind: subject.resourceKind,
    state,
    missingOwnerSetup: missing,
    ...(aiSource?.configured && aiSource.sourceKind ? { sourceKind: aiSource.sourceKind } : {}),
    effectiveSubmitMode: submitMode ?? "owner_only",
    items,
  });
}
