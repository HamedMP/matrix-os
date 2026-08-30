import { describe, expect, it } from "vitest";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import {
  canonicalProviderAvailabilityLabel,
  deriveCanonicalProviderChoices,
} from "../../packages/ui/src/canonical-provider-choice.js";

const catalog = CanonicalProviderCatalogSchema.parse({
  revision: "catalog_test",
  drivers: [
    { kind: "pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
    { kind: "opencode", displayName: "OpenCode", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
  ],
  instances: [{
    id: "pi_default",
    driverKind: "pi",
    displayName: "Pi",
    availability: "available",
    workspaceRequirement: "project_optional",
    models: [{
      id: "anthropic:claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      availability: "available",
      capabilities: ["reasoning", "tools"],
      supportsVision: false,
      supportsToolUse: true,
    }],
    options: [{
      id: "effort", label: "Reasoning", kind: "enum", placement: "composer",
      values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }],
      defaultValue: "high",
    }, { id: "thinking", label: "Thinking", kind: "boolean", placement: "advanced", defaultValue: true }],
    skills: [],
    commands: [],
    setupActions: [],
    supports: {
      rootChat: true, resume: true, cancellation: true, attachments: ["structured_ref"],
      tools: [], approvals: false, userInput: false, worktrees: "optional",
      resources: ["project"], interactionModes: ["default", "plan"], permissionModes: ["supervised", "full_access"],
    },
    defaultSelection: { instanceId: "pi_default", model: "anthropic:claude-sonnet-5" },
    catalogRevision: "catalog_test",
  }, {
    id: "opencode_default",
    driverKind: "opencode",
    displayName: "OpenCode",
    availability: "unavailable",
    unavailabilityReason: "runtime_not_runnable",
    workspaceRequirement: "project_optional",
    models: [], options: [], skills: [], commands: [], setupActions: [],
    supports: {
      rootChat: true, resume: true, cancellation: true, attachments: [], tools: [], approvals: false,
      userInput: false, worktrees: "optional", resources: [], interactionModes: [], permissionModes: [],
    },
    catalogRevision: "catalog_test",
  }],
});

describe("canonical Provider choice presentation", () => {
  it("derives only runnable exact instance/model choices", () => {
    expect(deriveCanonicalProviderChoices(catalog)).toEqual([{
      instanceId: "pi_default",
      driverKind: "pi",
      harnessLabel: "Pi",
      modelId: "anthropic:claude-sonnet-5",
      modelLabel: "Claude Sonnet 5",
      interactionMode: "default",
      interactionModes: ["default", "plan"],
      permissionMode: "supervised",
      permissionModes: ["supervised", "full_access"],
      options: catalog.instances[0]!.options,
      selectedOptions: [{ id: "effort", value: "high" }, { id: "thinking", value: true }],
      supportsFileAttachments: false,
    }]);
  });

  it("shares actionable unavailable reasons across shells", () => {
    expect(canonicalProviderAvailabilityLabel(catalog.instances[1]!)).toBe("Not supported in this runtime");
    expect(canonicalProviderAvailabilityLabel({
      ...catalog.instances[1]!,
      unavailabilityReason: "disabled_in_settings",
    })).toBe("Disabled in Settings");
  });
});
