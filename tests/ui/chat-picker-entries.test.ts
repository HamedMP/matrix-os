import type { CanonicalProviderCatalog, CanonicalProviderInstanceDescriptor } from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";
import { chatPickerEntryForSelection, deriveChatPickerEntries } from "../../packages/ui/src/chat-picker-entries.js";

const catalog: CanonicalProviderCatalog = {
  revision: "grouped-fixture",
  drivers: [{ kind: "matrix_pi", displayName: "Pi", adapterVersion: "1", capabilityClass: "system_agent" },
    { kind: "kernel", displayName: "Claude SDK", adapterVersion: "1", capabilityClass: "system_agent" },
    ...["pi", "opencode"].map(kind => ({
    kind: kind as "pi" | "opencode", displayName: kind, adapterVersion: "1", capabilityClass: "coding_agent",
  } as const))],
  instances: ["pi", "opencode"].flatMap(kind => [false, true].map(managed => ({
    id: `${kind}_${managed ? "managed" : "owner"}`, driverKind: kind as "pi" | "opencode", displayName: kind,
    availability: "unavailable" as const, workspaceRequirement: "project_optional" as const, catalogRevision: "grouped-fixture",
    ...(managed ? { connectionLabel: "Matrix AI", connectionState: "credit_required" as const } : {}),
    models: [], options: [], skills: [], commands: [], setupActions: [],
    supports: { rootChat: true, resume: true, cancellation: true, attachments: [], resources: [], tools: [],
      approvals: false, userInput: false, worktrees: "none" as const, interactionModes: ["default"], permissionModes: ["supervised"] },
  }))),
};
const base = catalog.instances[0]!;
const managed: CanonicalProviderInstanceDescriptor = { ...base, id: "matrix_pi_default", driverKind: "matrix_pi",
  displayName: "Matrix AI", connectionLabel: "Matrix AI", connectionState: "credit_required" };
const legacy: CanonicalProviderInstanceDescriptor = { ...managed, id: "kernel_matrix_included", driverKind: "kernel" };
catalog.instances.push(managed, legacy);

describe("Chat picker presentation groups", () => {
  it("groups only the owned Pi Matrix route while retaining generic coding entries", () => {
    const entries = deriveChatPickerEntries(catalog);
    expect(entries.map(entry => entry.id)).toEqual(["matrix-ai", "pi_owner", "pi_managed", "opencode_owner", "opencode_managed"]);
    expect(entries[0]!.instances.map(instance => instance.id)).toEqual(["matrix_pi_default"]);
    expect(entries.flatMap(entry => entry.instances).some(instance => instance.id === legacy.id)).toBe(false);
    for (const instance of catalog.instances.filter(instance => instance.id !== legacy.id)) {
      expect(entries.flatMap(entry => entry.instances).filter(candidate => candidate.id === instance.id)).toHaveLength(1);
    }
  });
  it("maps a retained owned Pi selection to Matrix AI and generic selections to their own entries", () => {
    const entries = deriveChatPickerEntries(catalog);
    expect(chatPickerEntryForSelection(entries, managed.id)).toBe("matrix-ai");
    expect(chatPickerEntryForSelection(entries, "pi_owner")).toBe("pi_owner");
    expect(chatPickerEntryForSelection(entries, "pi_managed")).toBe("pi_managed");
    expect(chatPickerEntryForSelection(entries, "opencode_owner")).toBe("opencode_owner");
    expect(chatPickerEntryForSelection(entries, "opencode_managed")).toBe("opencode_managed");
  });
  it.each([
    { ...managed, driverKind: "pi" as const },
    { ...managed, id: "matrix_pi_alias" },
  ])("does not promote a Matrix-labelled wrong-driver or alias descriptor ($id/$driverKind)", (descriptor) => {
    const entries = deriveChatPickerEntries({ ...catalog, instances: [descriptor, legacy] });
    expect(entries[0]!.instances).toEqual([]);
    expect(entries.flatMap(entry => entry.instances)).toEqual([descriptor]);
    expect(chatPickerEntryForSelection(entries, descriptor.id)).toBe(descriptor.id);
  });
});

describe("unimplemented plan catalog placeholders", () => {
  const placeholder: CanonicalProviderInstanceDescriptor = {
    ...base, id: "matrix_chatgpt_plan", driverKind: "matrix_bot", displayName: "Matrix_bot",
    availability: "unavailable", models: [], setupActions: [],
  };
  const withBot = (instance: CanonicalProviderInstanceDescriptor): CanonicalProviderCatalog => ({
    ...catalog, drivers: [...catalog.drivers, { kind: instance.driverKind, displayName: "Matrix bot", adapterVersion: "1", capabilityClass: "system_agent" }],
    instances: [...catalog.instances, instance],
  });
  it("omits only the empty unavailable plan placeholder from the shared source rail", () => {
    const input = withBot(placeholder);
    const entries = deriveChatPickerEntries(input);
    expect(entries.some(entry => entry.id === placeholder.id)).toBe(false);
    expect(entries.some(entry => entry.id === "pi_owner")).toBe(true);
    expect(input.instances).toContain(placeholder);
  });
  it.each([
    { ...placeholder, availability: "available" as const },
    { ...placeholder, driverKind: "openclaw" as const },
    { ...placeholder, models: [{ id: "auto", displayName: "Automatic", availability: "unavailable" as const, capabilities: [], supportsVision: false, supportsToolUse: true }] },
    { ...placeholder, setupActions: [{ id: "connect", kind: "open_settings" as const, label: "Connect bot" }] },
  ])("retains actual runtime, setup, and other provider descriptors ($availability)", (instance) => {
    expect(deriveChatPickerEntries(withBot(instance)).some(entry => entry.id === instance.id)).toBe(true);
  });
});
