// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import { CompactChatProviderChoices } from "../../packages/ui/src/compact-chat-provider-choices";
import { deriveCanonicalProviderChoices } from "../../packages/ui/src/canonical-provider-choice";
import { ProviderModelPicker } from "@desktop/renderer/src/features/chat/ProviderModelPicker";
import { canonicalComposerSelectionIsAvailable, createCanonicalComposerSelection } from "../../desktop/src/renderer/src/features/chat/canonical-composer-state";

function oldCatalog() {
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  catalog.drivers.push({ kind: "kernel", displayName: "Claude SDK", adapterVersion: "1.0.0", capabilityClass: "system_agent" },
    { kind: "matrix_pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "system_agent" },
    { kind: "pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "coding_agent" });
  catalog.instances = [{ ...base, id: "kernel_matrix_included", driverKind: "kernel", displayName: "Matrix AI", connectionLabel: "Matrix AI" },
    { ...base, id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Matrix AI", connectionLabel: "Matrix AI" },
    { ...base, id: "pi_owner", driverKind: "pi", displayName: "Pi · Work" }, base];
  for (const instance of catalog.instances) instance.defaultSelection = { instanceId: instance.id, model: instance.models[0]!.id };
  return catalog;
}
afterEach(cleanup);

it("offers only the managed Matrix model without runtime labels while retaining an owned Pi", () => {
  const catalog = oldCatalog();
  const choices = deriveCanonicalProviderChoices(catalog);
  const change = vi.fn();
  render(<CompactChatProviderChoices catalog={catalog} choices={choices} selected={null} onSelect={change} />);
  expect(choices.some(choice => choice.instanceId === "kernel_matrix_included")).toBe(false);
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option", { name: "GPT-5.6-Sol via Matrix AI" })).toBeEnabled();
  expect(screen.queryByText(/Claude SDK/)).toBeNull();
  fireEvent.click(screen.getByRole("option"));
  expect(change.mock.calls[0]![0].instanceId).toBe("matrix_pi_default");
  fireEvent.click(screen.getByRole("button", { name: "Pi · Work agent, Available" }));
  expect(screen.getByRole("option", { name: "GPT-5.6-Sol via Pi · Work" })).toBeEnabled();
});

it("keeps a bound legacy Matrix identity unavailable without selecting or defaulting to its SDK", () => {
  const catalog = oldCatalog();
  const selection = { instanceId: "kernel_matrix_included", model: "gpt-5.6-sol", options: [], interactionMode: "default", permissionMode: "supervised" };
  expect(canonicalComposerSelectionIsAvailable(catalog, selection)).toBe(false);
  expect(createCanonicalComposerSelection(catalog, selection.instanceId)?.instanceId).toBe("matrix_pi_default");
  const change = vi.fn();
  render(<ProviderModelPicker catalog={catalog} selection={selection} instanceLocked onChange={change} />);
  const trigger = screen.getByRole("button", { name: "Choose model and provider" });
  expect(trigger).toHaveAttribute("data-provider-instance", selection.instanceId);
  expect(within(trigger).getByText("Unavailable")).toBeVisible();
  fireEvent.click(trigger);
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option")).toBeDisabled();
  fireEvent.click(screen.getByRole("option"));
  expect(change).not.toHaveBeenCalled();
});

it("does not move focus to search on opening, supports explicit keyboard search, and restores the picker trigger", async () => {
  render(<ProviderModelPicker catalog={oldCatalog()} selection={null} instanceLocked={false} onChange={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Choose model and provider" });
  trigger.focus();
  fireEvent.click(trigger);
  const search = screen.getByRole("searchbox");
  expect(search).not.toHaveFocus();
  search.focus();
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(screen.getAllByRole("option")[0]).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("does not steal focus on mounting the shared flat chooser", () => {
  render(<><button type="button" autoFocus>Continue draft</button><CompactChatProviderChoices choices={[]} selected={null} onSelect={vi.fn()} /></>);
  expect(screen.getByRole("searchbox")).not.toHaveFocus();
  expect(screen.getByRole("button", { name: "Continue draft" })).toHaveFocus();
});

it("uses the Matrix presentation label and glyph for a managed route from an older catalog", () => {
  const catalog = oldCatalog();
  catalog.instances.find(instance => instance.id === "matrix_pi_default")!.displayName = "Pi";
  render(<ProviderModelPicker catalog={catalog} selection={{ instanceId: "matrix_pi_default", model: "gpt-5.6-sol", options: [], interactionMode: "default", permissionMode: "supervised" }} instanceLocked={false} onChange={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Choose model and provider" });
  expect(within(trigger).getByText("GPT-5.6-Sol · Matrix AI")).toBeVisible();
  expect(trigger.querySelector('[data-provider-glyph="kernel"]')).not.toBeNull();
  expect(trigger.querySelector('[data-provider-glyph="matrix_pi"]')).toBeNull();
  fireEvent.click(trigger);
  const matrixOption = screen.getByRole("option", { name: "GPT-5.6-Sol via Matrix AI" });
  expect(matrixOption.querySelector('[data-provider-glyph="kernel"]')).not.toBeNull();
  expect(matrixOption.querySelector('[data-provider-glyph="matrix_pi"]')).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Pi · Work agent, Available" }));
  expect(screen.getByRole("option").querySelector('[data-provider-glyph="pi"]')).not.toBeNull();
});

it("retains historical bound SDK identity in the actual selection hook when an old catalog advertises it ready", async () => {
  const { renderHook } = await import("@testing-library/react");
  const { useCanonicalComposerSelection } = await import("../../desktop/src/renderer/src/features/chat/use-canonical-composer-selection");
  const props = { catalog: oldCatalog(), catalogReady: true,
    initializeImmediately: false, chatId: "historical_chat", boundInstanceId: "kernel_matrix_included",
    currentSelection: { instanceId: "kernel_matrix_included", model: "gpt-5.6-sol" } };
  const hook = renderHook(() => useCanonicalComposerSelection(props));
  expect(hook.result.current.selection?.instanceId).toBe("kernel_matrix_included");
  expect(hook.result.current.selection?.model).toBe("gpt-5.6-sol");
  expect(canonicalComposerSelectionIsAvailable(oldCatalog(), hook.result.current.selection)).toBe(false);
});
