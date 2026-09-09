import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";

export const owner = { type: "personal" as const, ownerId: "owner_projection" };
export const principal = { userId: owner.ownerId, source: "configured-container" as const };
export const catalog = CanonicalProviderCatalogSchema.parse({
  revision: "catalog_projection",
  drivers: [{ kind: "codex", displayName: "Codex", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
  instances: [{
    id: "codex_default", driverKind: "codex", displayName: "Codex", availability: "available",
    workspaceRequirement: "project_optional", catalogRevision: "catalog_projection",
    models: [{ id: "model", displayName: "Model", availability: "available", capabilities: ["tools"],
      supportsVision: false, supportsToolUse: true }],
    options: [], skills: [], commands: [], setupActions: [],
    supports: { rootChat: true, resume: true, cancellation: true, steering: "same_run",
      attachments: [], tools: [], approvals: true, userInput: true, worktrees: "optional",
      resources: [], interactionModes: ["default"], permissionModes: ["supervised"] },
  }],
});
