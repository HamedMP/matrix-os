import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react-native";
import { ModelPicker } from "@/components/ModelPicker";
import { ProviderLogo } from "@/components/ui/ProviderLogo";
import { createCanonicalProviderCatalogFixture } from "../../../tests/contracts/fixtures/canonical-chat";

import { flat } from "./ui-test-utils";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

interface MenuAction { id?: string; title: string; state?: "on" | "off"; attributes?: { disabled?: boolean } }

// The native menu, drawn as its trigger followed by the titles of its items.
jest.mock("@expo/ui/community/menu", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View, Text } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    MenuView: (props: { actions: MenuAction[]; children?: React.ReactNode }) => React.createElement(
      View,
      props,
      props.children,
      React.createElement(
        View,
        { testID: "model-menu-items" },
        props.actions.map((action) => React.createElement(Text, { key: action.id }, action.title)),
      ),
    ),
  };
});

const selection = { instanceId: "matrix_pi_default", model: "anthropic:claude-sonnet-5" };
function managedCatalog() {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  catalog.instances = [{ ...base, id: selection.instanceId, driverKind: "matrix_pi", displayName: "Pi", connectionLabel: "Matrix AI",
    models: [{ ...base.models[0]!, id: selection.model, displayName: "Sonnet 5" }] }];
  return catalog;
}

/** Chooses an item of the native menu, as a tap on it does. */
function choose(instanceId: string, model: string) {
  fireEvent(screen.getByTestId("model-menu"), "pressAction", { nativeEvent: { event: `${instanceId}::${model}` } });
}
function menuActions(): MenuAction[] {
  return screen.getByTestId("model-menu").props.actions;
}
function menuItems() {
  return within(screen.getByTestId("model-menu-items"));
}
/** What the trigger shows as chosen. */
function triggerValue(): string {
  return screen.getByRole("button", { name: "Model" }).props.accessibilityValue.text;
}

afterEach(cleanup);

it("shows the engine's logo and name before the model, and ticks the chosen model in the menu", () => {
  render(<ModelPicker catalog={managedCatalog()} selection={selection} onSelectionChange={jest.fn()} />);
  expect(screen.getByText("Matrix AI · Sonnet 5")).toBeTruthy();
  expect(triggerValue()).toBe("Matrix AI · Sonnet 5");
  expect(screen.UNSAFE_getByType(ProviderLogo).props.provider).toBe("matrix");
  expect(menuActions()).toEqual([
    { id: `${selection.instanceId}::${selection.model}`, title: "Sonnet 5 · Matrix AI", state: "on", attributes: { disabled: false } },
  ]);
});
it("leaves the selection, and the options saved with it, alone when the ticked model is chosen again", () => {
  const change = jest.fn();
  const withEffort = { ...selection, options: [{ id: "effort", value: "high" }] };
  render(<ModelPicker catalog={managedCatalog()} selection={withEffort} onSelectionChange={change} />);
  choose(selection.instanceId, selection.model);
  expect(change).not.toHaveBeenCalled();
});
it("shows an agent engine under its own logo", () => {
  const catalog = createCanonicalProviderCatalogFixture();
  const codex = { instanceId: "codex_fixture", model: "gpt-5.6-sol" };
  render(<ModelPicker catalog={catalog} selection={codex} onSelectionChange={jest.fn()} />);
  expect(triggerValue()).toBe("Codex fixture · GPT-5.6-Sol");
  expect(screen.UNSAFE_getByType(ProviderLogo).props.provider).toBe("codex");
});
it("limits the label to the room the composer's toolbar leaves beside its buttons", () => {
  render(<ModelPicker catalog={managedCatalog()} selection={selection} onSelectionChange={jest.fn()} />);
  // 750pt test window, less 2 x (12 margin + 14 padding + 44 button + 8 gap) and 2 x (10 padding + 6 gap + 14 icon).
  expect(flat(screen.getByText("Matrix AI · Sonnet 5")).maxWidth).toBe(750 - 156 - 60);
});
it("no longer offers the reasoning-effort choice beside the model", () => {
  const catalog = managedCatalog();
  catalog.instances[0]!.options = [{ id: "effort", label: "Effort", kind: "enum", placement: "composer", defaultValue: "medium",
    values: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }] }] as never;
  render(<ModelPicker catalog={catalog} selection={selection} onSelectionChange={jest.fn()} />);
  expect(screen.queryByTestId("model-option-picker")).toBeNull();
  expect(screen.queryByLabelText("Effort")).toBeNull();
});
it("retains the saved model when every route is unavailable and shows a safe recovery reason", () => {
  const catalog = managedCatalog();
  catalog.instances[0]!.availability = "unavailable";
  catalog.instances[0]!.unavailabilityReason = "disabled_in_settings";
  const change = jest.fn();
  render(<ModelPicker catalog={catalog} selection={selection} onSelectionChange={change} />);
  expect(screen.getByText("Matrix AI · Sonnet 5 · unavailable")).toBeTruthy();
  expect(screen.getByText(/Disabled in Settings.*Agents & providers/)).toBeTruthy();
  // With nothing to choose there is no menu, so the saved model cannot be picked again.
  expect(screen.queryByTestId("model-menu")).toBeNull();
  expect(screen.getByRole("button", { name: "Model" }).props.accessibilityState).toMatchObject({ disabled: true });
  expect(change).not.toHaveBeenCalled();
});
it("retains missing saved model identity while offering a deliberate replacement", () => {
  const catalog = managedCatalog();
  const change = jest.fn();
  const missing = { ...selection, model: "cloudflare:@cf/zai-org/glm-5.3-flash" };
  render(<ModelPicker catalog={catalog} selection={missing} onSelectionChange={change} />);
  expect(triggerValue()).toBe(`Matrix AI · ${missing.model} · unavailable`);
  expect(menuItems().getByText(`${missing.model} · Matrix AI · unavailable`)).toBeTruthy();
  expect(menuActions()[0]).toMatchObject({ state: "on", attributes: { disabled: true } });
  choose(missing.instanceId, missing.model);
  expect(change).not.toHaveBeenCalled();
  choose(selection.instanceId, selection.model);
  expect(change).toHaveBeenCalledWith(selection);
});
it("distinguishes identical Sonnet names on kernel and owned Pi routes", () => {
  const catalog = managedCatalog();
  catalog.instances.push({ ...catalog.instances[0]!, id: "kernel_default", driverKind: "kernel", displayName: "Kernel" });
  render(<ModelPicker catalog={catalog} selection={selection} onSelectionChange={jest.fn()} />);
  expect(menuItems().getByText("Sonnet 5 · Matrix AI")).toBeTruthy();
  expect(menuItems().getByText("Sonnet 5 · Matrix AI · Kernel")).toBeTruthy();
});
it("keeps a saved identity visible while catalog verification is loading", () => {
  render(<ModelPicker catalog={null} selection={selection} onSelectionChange={jest.fn()} />);
  expect(screen.getByText(new RegExp(selection.model))).toBeTruthy();
  expect(triggerValue()).toBe(`${selection.model} · checking`);
  expect(screen.getByText(/Checking model availability/)).toBeTruthy();
});
it("says the models are being checked before there is anything to choose", () => {
  render(<ModelPicker catalog={null} selection={null} catalogLoading onSelectionChange={jest.fn()} />);
  expect(triggerValue()).toBe("Checking models…");
  expect(screen.getByLabelText("Checking model availability")).toBeTruthy();
  expect(screen.queryByTestId("model-menu")).toBeNull();
});

it("shows credit-reserved discovery as disabled noninteractive text outside the executable native menu", () => {
  const catalog = managedCatalog();
  const held = catalog.instances[0]!;
  held.availability = "unavailable";
  held.connectionState = "credit_reserved";
  held.defaultSelection = undefined;
  held.models[0]!.availability = "unavailable";
  const change = jest.fn();
  render(<ModelPicker catalog={catalog} selection={selection} onSelectionChange={change} />);
  const row = screen.getByText("Sonnet 5 · Matrix AI · Credit reserved");
  expect(row.props.accessibilityState).toEqual({ disabled: true });
  expect(row.props.onPress).toBeUndefined();
  expect(screen.queryByTestId("model-menu")).toBeNull();
  expect(triggerValue()).toBe("Matrix AI · Sonnet 5");
  expect(screen.getByText("Your credit is reserved while usage is confirmed.")).toBeTruthy();
  expect(change).not.toHaveBeenCalled();
});

it("keeps held models visible before any selection without offering a default or unauthorized model", () => {
  const catalog = managedCatalog();
  catalog.instances[0]!.availability = "unavailable";
  catalog.instances[0]!.connectionState = "credit_reserved";
  catalog.instances[0]!.defaultSelection = undefined;
  catalog.instances[0]!.models[0]!.availability = "unavailable";
  render(<ModelPicker catalog={catalog} selection={null} onSelectionChange={jest.fn()} />);
  expect(screen.queryByTestId("model-menu")).toBeNull();
  expect(screen.getByRole("button", { name: "Model" }).props.accessibilityState).toMatchObject({ disabled: true });
  expect(triggerValue()).toBe("Choose a model");
  expect(screen.getByText("Sonnet 5 · Matrix AI · Credit reserved")).toBeTruthy();
  expect(screen.queryByText(/GLM/)).toBeNull();
});
it("does not label a revoked saved model with another model's credit reservation", () => {
  const catalog = managedCatalog();
  catalog.instances[0]!.availability = "unavailable";
  catalog.instances[0]!.connectionState = "credit_reserved";
  catalog.instances[0]!.defaultSelection = undefined;
  catalog.instances[0]!.models[0]!.availability = "unavailable";
  const missing = { ...selection, model: "anthropic:revoked-model" };
  render(<ModelPicker catalog={catalog} selection={missing} onSelectionChange={jest.fn()} />);
  expect(screen.getByText("Matrix AI · anthropic:revoked-model · unavailable")).toBeTruthy();
  expect(screen.getByText(/Saved model unavailable/)).toBeTruthy();
});
it("keeps an unavailable peer model noninteractive beside the ready native menu", () => {
  const catalog = managedCatalog();
  catalog.instances[0]!.models.push({ ...catalog.instances[0]!.models[0]!, id: "cloudflare:@cf/zai-org/glm-5.3-flash", displayName: "GLM Flash", availability: "unavailable" });
  catalog.instances[0]!.models.push({ ...catalog.instances[0]!.models[0]!, id: "anthropic:claude-opus-5", displayName: "Opus 5" });
  const change = jest.fn();
  render(<ModelPicker catalog={catalog} selection={selection} onSelectionChange={change} />);
  const row = screen.getByText("GLM Flash · Matrix AI · Model unavailable");
  expect(row.props.accessibilityState).toEqual({ disabled: true });
  expect(menuItems().queryByText(/GLM/)).toBeNull();
  choose(selection.instanceId, "cloudflare:@cf/zai-org/glm-5.3-flash");
  expect(change).not.toHaveBeenCalled();
  // The model already ticked is not a change; another one that can run is.
  choose(selection.instanceId, "anthropic:claude-opus-5");
  expect(change).toHaveBeenCalledWith({ instanceId: selection.instanceId, model: "anthropic:claude-opus-5" });
});

it("omits retired Matrix SDK options and never selects a legacy identity from an old catalog", () => {
  const catalog = managedCatalog();
  catalog.instances.unshift({ ...catalog.instances[0]!, id: "kernel_matrix_included", driverKind: "kernel", displayName: "Claude SDK",
    models: [{ ...catalog.instances[0]!.models[0]!, displayName: "SDK duplicate" }] });
  const change = jest.fn();
  render(<ModelPicker catalog={catalog} selection={selection} onSelectionChange={change} />);
  expect(screen.queryByText(/SDK duplicate/)).toBeNull();
  choose("kernel_matrix_included", selection.model);
  expect(change).not.toHaveBeenCalled();
});
it("shows accessible loading while retaining the selected managed name and blocking model changes", () => {
  const change = jest.fn();
  render(<ModelPicker catalog={managedCatalog()} selection={selection} catalogLoading onSelectionChange={change} />);
  expect(screen.getByLabelText("Checking model availability")).toBeTruthy();
  expect(screen.getByText("Matrix AI · Sonnet 5")).toBeTruthy();
  expect(menuActions().every((action) => action.attributes?.disabled === true)).toBe(true);
  choose(selection.instanceId, selection.model);
  expect(change).not.toHaveBeenCalled();
});
