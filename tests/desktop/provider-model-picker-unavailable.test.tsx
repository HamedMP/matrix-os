// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderModelPicker } from "@desktop/renderer/src/features/chat/ProviderModelPicker";
import { providerCatalog } from "./canonical-chat-workspace-test-utils";
afterEach(cleanup);
it.each(["model_missing", "model_disabled", "instance_disabled", "instance_missing"] as const)("explains retained unavailable selection in the closed picker (%s)", (reason) => {
  const instance = providerCatalog.instances[0]!;
  const catalog = { ...providerCatalog, instances: reason === "instance_missing" ? [] : [{ ...instance,
    availability: reason === "instance_disabled" ? "unavailable" as const : instance.availability,
    models: reason === "model_missing" ? [] : instance.models.map((model) => ({ ...model,
      availability: reason === "model_disabled" ? "unavailable" as const : model.availability })) }] };
  render(<ProviderModelPicker catalog={catalog} selection={{ instanceId: instance.id, model: "gpt-5.6-sol", options: [], interactionMode: "default", permissionMode: "supervised" }} instanceLocked onChange={vi.fn()} />);
  const button = screen.getByRole("button", { name: "Choose model and provider" });
  expect(button.textContent).toContain("Unavailable");
  expect(button.title).toContain("Unavailable");
  expect(screen.getByText("Unavailable").className).toContain("shrink-0");
  expect(button.getAttribute("data-model")).toBe("gpt-5.6-sol");
  expect(button.getAttribute("data-provider-instance")).toBe(instance.id);
});
it("does not label an available selection or no selection unavailable", () => {
  const view = render(<ProviderModelPicker catalog={providerCatalog} selection={null} instanceLocked={false} onChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Choose model and provider" }).textContent).toContain("Choose model");
  view.rerender(<ProviderModelPicker catalog={providerCatalog} selection={{ instanceId: "codex_fixture", model: "gpt-5.6-sol", options: [], interactionMode: "default", permissionMode: "supervised" }} instanceLocked onChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Choose model and provider" }).textContent).not.toContain("Unavailable");
});
