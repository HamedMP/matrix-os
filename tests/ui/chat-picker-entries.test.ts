import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";
import { chatPickerEntryForSelection, deriveChatPickerEntries } from "../../packages/ui/src/chat-picker-entries.js";

const catalog: CanonicalProviderCatalog = {
  revision: "grouped-fixture",
  drivers: ["pi", "opencode"].map(kind => ({
    kind: kind as "pi" | "opencode", displayName: kind, adapterVersion: "1", capabilityClass: "coding_agent",
  })),
  instances: ["pi", "opencode"].flatMap(kind => [false, true].map(managed => ({
    id: `${kind}_${managed ? "managed" : "owner"}`, driverKind: kind as "pi" | "opencode", displayName: kind,
    availability: "unavailable" as const, workspaceRequirement: "project_optional" as const, catalogRevision: "grouped-fixture",
    ...(managed ? { connectionLabel: "Matrix AI", connectionState: "credit_required" as const } : {}),
    models: [], options: [], skills: [], commands: [], setupActions: [],
    supports: { rootChat: true, resume: true, cancellation: true, attachments: [], resources: [], tools: [],
      approvals: false, userInput: false, worktrees: "none" as const, interactionModes: ["default"], permissionModes: ["supervised"] },
  }))),
};

describe("Chat picker presentation groups", () => {
  it("groups managed Pi/OpenCode once while retaining each own-account entry", () => {
    const entries = deriveChatPickerEntries(catalog);
    expect(entries.map(entry => entry.id)).toEqual(["matrix-ai", "pi_owner", "opencode_owner"]);
    expect(entries[0]!.instances.map(instance => instance.id)).toEqual(["pi_managed", "opencode_managed"]);
    for (const instance of catalog.instances) {
      expect(entries.flatMap(entry => entry.instances).filter(candidate => candidate.id === instance.id)).toHaveLength(1);
    }
  });
  it("maps a retained managed selection to Matrix AI and an owner selection to its own entry", () => {
    const entries = deriveChatPickerEntries(catalog);
    expect(chatPickerEntryForSelection(entries, "opencode_managed")).toBe("matrix-ai");
    expect(chatPickerEntryForSelection(entries, "opencode_owner")).toBe("opencode_owner");
  });
});
