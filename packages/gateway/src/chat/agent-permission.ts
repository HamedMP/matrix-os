import {
  CanonicalChatSafeErrorSchema,
  type CanonicalChatModelSelection,
  type CanonicalChatSafeError,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";

/** Explain a saved Agent's runtime limit without granting broader permissions. */
export function unsupportedAgentPermissionMode(
  catalog: CanonicalProviderCatalog,
  selection: CanonicalChatModelSelection,
  permissionMode: string,
  isAgentRequest: boolean,
): CanonicalChatSafeError | null {
  if (!isAgentRequest || permissionMode === "full_access") return null;
  const instance = catalog.instances.find((item) => item.id === selection.instanceId);
  if (!instance || instance.availability !== "available"
    || instance.supports.permissionModes.includes(permissionMode)
    || !instance.supports.permissionModes.includes("full_access")) return null;
  return CanonicalChatSafeErrorSchema.parse({
    code: "agent_full_access_required",
    safeMessage: "This Agent's runtime requires Full access. Enable it for this request or choose a different Agent model.",
    retryable: false,
  });
}
