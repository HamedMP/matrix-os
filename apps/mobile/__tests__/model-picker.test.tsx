import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react-native";
import { ModelPicker } from "@/components/ModelPicker";
import { createCanonicalProviderCatalogFixture } from "../../../tests/contracts/fixtures/canonical-chat";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

jest.mock("@expo/ui", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View, Text } = jest.requireActual<typeof import("react-native")>("react-native");
  const Picker = (props: { children?: React.ReactNode }) => React.createElement(View, props, props.children);
  function PickerItem({ label }: { label: string }) { return React.createElement(Text, null, label); }
  Picker.Item = PickerItem;
  return { Host: ({ children }: { children?: React.ReactNode }) => children, Picker };
});
const selection = { instanceId: "matrix_pi_default", model: "anthropic:claude-sonnet-5" };
function managedCatalog() {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  catalog.instances = [{ ...base, id: selection.instanceId, driverKind: "matrix_pi", displayName: "Pi", connectionLabel: "Matrix AI",
    models: [{ ...base.models[0]!, id: selection.model, displayName: "Sonnet 5" }] }];
  return catalog;
}
it("retains the saved model when every route is unavailable and shows a safe recovery reason", () => {
  const catalog = managedCatalog();
  catalog.instances[0]!.availability = "unavailable";
  catalog.instances[0]!.unavailabilityReason = "disabled_in_settings";
  const change = jest.fn();
  render(<ModelPicker catalog={catalog} selection={selection} onSelectionChange={change} />);
  expect(screen.getByText("Sonnet 5 · Matrix AI · Pi · unavailable")).toBeTruthy();
  expect(screen.getByText(/Disabled in Settings.*Agents & providers/)).toBeTruthy();
  fireEvent(screen.getByTestId("model-picker"), "valueChange", `${selection.instanceId}::${selection.model}`);
  expect(change).not.toHaveBeenCalled();
});
it("retains missing saved model identity while offering a deliberate replacement", () => {
  const catalog = managedCatalog();
  const change = jest.fn();
  const missing = { ...selection, model: "cloudflare:@cf/zai-org/glm-5.3-flash" };
  render(<ModelPicker catalog={catalog} selection={missing} onSelectionChange={change} />);
  expect(screen.getByText(`${missing.model} · Matrix AI · Pi · unavailable`)).toBeTruthy();
  fireEvent(screen.getByTestId("model-picker"), "valueChange", `${selection.instanceId}::${selection.model}`);
  expect(change).toHaveBeenCalledWith(selection);
});
it("distinguishes identical Sonnet names on kernel and owned Pi routes", () => {
  const catalog = managedCatalog();
  catalog.instances.push({ ...catalog.instances[0]!, id: "kernel_default", driverKind: "kernel", displayName: "Kernel" });
  render(<ModelPicker catalog={catalog} selection={selection} onSelectionChange={jest.fn()} />);
  expect(screen.getByText("Sonnet 5 · Matrix AI · Pi")).toBeTruthy();
  expect(screen.getByText("Sonnet 5 · Matrix AI · Kernel")).toBeTruthy();
});
it("keeps a saved identity visible while catalog verification is loading", () => {
  render(<ModelPicker catalog={null} selection={selection} onSelectionChange={jest.fn()} />);
  expect(screen.getByText(new RegExp(selection.model))).toBeTruthy();
  expect(screen.getByText(/Checking model availability/)).toBeTruthy();
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
  const row = screen.getByText("Sonnet 5 · Matrix AI · Pi · Credit reserved");
  expect(row.props.accessibilityState).toEqual({ disabled: true });
  expect(row.props.onPress).toBeUndefined();
  expect(within(screen.getByTestId("model-picker")).queryByText(/Sonnet 5/)).toBeNull();
  expect(screen.getByText("Your credit is reserved while usage is confirmed.")).toBeTruthy();
  fireEvent(screen.getByTestId("model-picker"), "valueChange", `${selection.instanceId}::${selection.model}`);
  expect(change).not.toHaveBeenCalled();
});

it("keeps held models visible before any selection without offering a default or unauthorized model", () => {
  const catalog = managedCatalog();
  catalog.instances[0]!.availability = "unavailable";
  catalog.instances[0]!.connectionState = "credit_reserved";
  catalog.instances[0]!.defaultSelection = undefined;
  catalog.instances[0]!.models[0]!.availability = "unavailable";
  render(<ModelPicker catalog={catalog} selection={null} onSelectionChange={jest.fn()} />);
  expect(screen.getByTestId("model-picker").props.enabled).toBe(false);
  expect(screen.getByText("Sonnet 5 · Matrix AI · Pi · Credit reserved")).toBeTruthy();
  expect(within(screen.getByTestId("model-picker")).queryByText(/Sonnet 5/)).toBeNull();
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
  expect(screen.getByText("anthropic:revoked-model · Matrix AI · Pi · unavailable")).toBeTruthy();
  expect(screen.getByText(/Saved model unavailable/)).toBeTruthy();
});
it("keeps an unavailable peer model noninteractive beside the ready native menu", () => {
  const catalog = managedCatalog();
  catalog.instances[0]!.models.push({ ...catalog.instances[0]!.models[0]!, id: "cloudflare:@cf/zai-org/glm-5.3-flash", displayName: "GLM Flash", availability: "unavailable" });
  const change = jest.fn();
  render(<ModelPicker catalog={catalog} selection={selection} onSelectionChange={change} />);
  const row = screen.getByText("GLM Flash · Matrix AI · Pi · Model unavailable");
  expect(row.props.accessibilityState).toEqual({ disabled: true });
  expect(within(screen.getByTestId("model-picker")).queryByText(/GLM/)).toBeNull();
  fireEvent(screen.getByTestId("model-picker"), "valueChange", `${selection.instanceId}::${selection.model}`);
  expect(change).toHaveBeenCalledWith(selection);
});
