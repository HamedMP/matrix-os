import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { ModelPicker } from "@/components/ModelPicker";
import { createCanonicalProviderCatalogFixture } from "../../../tests/contracts/fixtures/canonical-chat";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

jest.mock("@expo/ui", () => {
  const React = require("react");
  const { View, Text } = require("react-native");
  const Picker = (props: any) => React.createElement(View, props, props.children);
  Picker.Item = ({ label }: { label: string }) => React.createElement(Text, null, label);
  return { Host: ({ children }: any) => children, Picker };
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
