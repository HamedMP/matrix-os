// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { CanonicalProviderCatalogSchema, type CanonicalProviderDriverKind } from "@matrix-os/contracts";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { ProviderModelPicker } from "@desktop/renderer/src/features/chat/ProviderModelPicker";
import { useProviderSetup } from "../../desktop/src/renderer/src/features/chat/use-provider-setup";
import { executeCatalogProviderSetupAction } from "../../desktop/src/renderer/src/features/coding-agents/provider-setup-terminal";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

function heldCatalog(driverKind: "matrix_pi" | "kernel") {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  catalog.drivers = [{ kind: driverKind, displayName: "Matrix AI", adapterVersion: "1.0.0", capabilityClass: "system_agent" }];
  catalog.instances = [{ ...base, id: driverKind === "matrix_pi" ? "matrix_pi_default" : "kernel_matrix_included",
    driverKind, displayName: "Matrix AI", connectionLabel: "Matrix AI", connectionState: "credit_reserved",
    availability: "unavailable", defaultSelection: undefined,
    models: [{ ...base.models[0]!, id: "anthropic:claude-sonnet-5", displayName: "Claude Sonnet 5", availability: "unavailable" }],
    setupActions: [{ id: "matrix_ai_settings", kind: "open_settings", label: "Agents & providers" }] }];
  return CanonicalProviderCatalogSchema.parse(catalog);
}

beforeEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
  useUi.setState({ requestedSettingsSection: null });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["matrix_pi", "kernel"] as const)("opens Agents & providers from the held %s picker without provider or Terminal setup", async (driverKind) => {
  const catalog = heldCatalog(driverKind);
  const instance = catalog.instances[0]!;
  const refresh = vi.fn();
  const change = vi.fn();
  const error = vi.spyOn(toast, "error");
  function Picker() {
    const setup = useProviderSetup([], refresh, null);
    return <ProviderModelPicker catalog={catalog} instanceLocked onChange={change} onSetupAction={setup}
      selection={{ instanceId: instance.id, model: instance.models[0]!.id, options: [], interactionMode: "default", permissionMode: "supervised" }} />;
  }
  render(<Picker />);
  fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
  expect(screen.getByRole("option", { name: /Claude Sonnet 5/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Agents & providers" }));
  await waitFor(() => expect(useUi.getState().requestedSettingsSection).toBe("agents-providers"));
  const settings = useTabs.getState().tabs.filter((tab) => tab.kind === "settings");
  expect(settings).toHaveLength(1);
  expect(useTabs.getState().activeTabId).toBe(settings[0]!.id);
  expect(useTabs.getState().tabs.some((tab) => tab.kind === "terminals")).toBe(false);
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  expect(change).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

it.each([
  { driverKind: "matrix_pi", id: "matrix_pi_custom", actionId: "matrix_ai_settings" },
  { driverKind: "kernel", id: "kernel_custom", actionId: "matrix_ai_settings" },
  { driverKind: "kernel", id: "matrix_pi_default", actionId: "matrix_ai_settings" },
  { driverKind: "matrix_pi", id: "matrix_pi_default", actionId: "matrix_pi_settings" },
  { driverKind: "kernel", id: "kernel_matrix_included", actionId: "kernel_settings" },
  { driverKind: "hermes", id: "hermes_default", actionId: "matrix_ai_settings" },
  { driverKind: "openclaw", id: "openclaw_default", actionId: "matrix_ai_settings" },
] satisfies Array<{ driverKind: CanonicalProviderDriverKind; id: string; actionId: string }>)("keeps unrelated/retired Settings actions rejected ($driverKind/$id/$actionId)", async ({ driverKind, id, actionId }) => {
  const base = heldCatalog("matrix_pi").instances[0]!;
  const action = { id: actionId, kind: "open_settings" as const, label: "Agents & providers" };
  const opened = await executeCatalogProviderSetupAction({
    instance: { ...base, id, driverKind, setupActions: [action] }, action, api: null, openTab: useTabs.getState().openTab,
  });
  expect(opened).toBe(false);
  expect(useUi.getState().requestedSettingsSection).toBeNull();
  expect(useTabs.getState().tabs).toHaveLength(0);
});

it("rejects an action absent from the actual managed catalog descriptor", async () => {
  const instance = heldCatalog("matrix_pi").instances[0]!;
  const action = instance.setupActions[0]!;
  const opened = await executeCatalogProviderSetupAction({ instance: { ...instance, setupActions: [] }, action,
    api: null, openTab: useTabs.getState().openTab });
  expect(opened).toBe(false);
  expect(useUi.getState().requestedSettingsSection).toBeNull();
  expect(useTabs.getState().tabs).toHaveLength(0);
});
