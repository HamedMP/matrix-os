// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalProviderModelRouteLabel } from "@matrix-os/contracts";
import { deriveCanonicalProviderChoices } from "../../packages/ui/src/canonical-provider-choice.js";
import { chatPickerEntryForSelection, deriveChatPickerEntries } from "../../packages/ui/src/chat-picker-entries.js";
import { CompactChatProviderChoices } from "../../packages/ui/src/compact-chat-provider-choices.js";
import { ordinaryPlanCatalog, planBinding, planId } from "./ordinary-chatgpt-plan-fixture.js";

afterEach(cleanup);
const fundedId = "matrix_pi_default";
function groupedCatalog() {
  const catalog = ordinaryPlanCatalog(), base = catalog.instances[0]!;
  catalog.instances.push({ ...base, id: fundedId, driverKind: "matrix_pi", displayName: "Matrix AI", connectionLabel: "Matrix AI",
    defaultSelection: { instanceId: fundedId, model: "funded-claude" },
    models: [{ ...base.models[0]!, id: "funded-claude", displayName: "Funded Claude" }] });
  catalog.drivers.push({ kind: "claude_code", displayName: "Claude Code", adapterVersion: "1", capabilityClass: "coding_agent" });
  catalog.instances.push({ ...base, id: "claude_code_default", driverKind: "claude_code", displayName: "Claude Code" });
  return catalog;
}
function show(catalog = groupedCatalog(), selectedId = fundedId, lockedInstanceId?: string) {
  const choices = deriveCanonicalProviderChoices(catalog), select = vi.fn(), setup = vi.fn();
  const selected = choices.find(choice => choice.instanceId === selectedId) ?? { instanceId: selectedId, modelId: "gpt-owner" };
  const view = render(<CompactChatProviderChoices catalog={catalog} choices={choices} selected={selected}
    lockedInstanceId={lockedInstanceId} onSelect={select} onSetupAction={setup} renderDriverIcon={kind => <span data-testid={`glyph-${kind}`}/>}/>);
  return { ...view, select, setup };
}
const personalRow = () => screen.getByRole("option", { name: "Owner GPT via Matrix AI · ChatGPT subscription" });
const fundedRow = () => screen.getByRole("option", { name: "Funded Claude via Matrix AI" });

it("groups both exact Matrix sources under the rabbit while keeping native Coding categories independent", () => {
  const catalog = groupedCatalog(), entries = deriveChatPickerEntries(catalog);
  expect(entries.find(entry => entry.id === "matrix-ai")).toMatchObject({ iconKind: "kernel", capabilityClass: "system_agent" });
  expect(entries.find(entry => entry.id === "matrix-ai")?.instances.map(instance => instance.id)).toEqual([planId, fundedId]);
  expect(entries.some(entry => entry.id === planId)).toBe(false);
  expect(chatPickerEntryForSelection(entries, planId)).toBe("matrix-ai");
  show(catalog);
  expect(within(screen.getByRole("group", { name: "General agents" })).getAllByRole("button")).toHaveLength(1);
  expect(within(screen.getByRole("group", { name: "Coding agents" })).getAllByRole("button")).toHaveLength(2);
  expect(fundedRow()).toBeEnabled();
  expect(personalRow()).toBeEnabled();
  expect(within(personalRow()).getByTestId("glyph-kernel")).toBeVisible();
});
it.each(["funded", "personal"] as const)("keeps the other source independently selectable when %s is unavailable", unavailable => {
  const catalog = groupedCatalog(), source = catalog.instances.find(instance => instance.id === (unavailable === "funded" ? fundedId : planId))!;
  source.availability = "unavailable";
  if (unavailable === "funded") source.connectionState = "credit_required";
  const { select } = show(catalog);
  expect(screen.getByRole("button", { name: "Matrix AI agent, Available" })).toBeEnabled();
  const ready = unavailable === "funded" ? personalRow() : fundedRow();
  const blocked = unavailable === "funded" ? fundedRow() : personalRow();
  expect(ready).toBeEnabled(); expect(blocked).toBeDisabled();
  fireEvent.click(blocked); expect(select).not.toHaveBeenCalled();
  fireEvent.click(ready);
  expect(select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanceId: unavailable === "funded" ? planId : fundedId,
    ...(unavailable === "funded" ? { selectedOptions: planBinding } : {}) }));
});
it.each([fundedId, planId])("preserves first-turn source locking inside Matrix AI for %s", lockedId => {
  const { select } = show(groupedCatalog(), lockedId, lockedId);
  const unlocked = lockedId === planId ? personalRow() : fundedRow(), locked = lockedId === planId ? fundedRow() : personalRow();
  expect(unlocked).toHaveAttribute("aria-selected", "true"); expect(unlocked).toBeEnabled(); expect(locked).toBeDisabled();
  fireEvent.click(locked); expect(select).not.toHaveBeenCalled();
  fireEvent.click(unlocked); expect(select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanceId: lockedId }));
});
it("searches subscription funding, selects exact authority and reopens Matrix AI without search autofocus or loading", () => {
  const catalog = groupedCatalog(), first = show(catalog), search = screen.getByRole("searchbox");
  fireEvent.change(search, { target: { value: "ChatGPT subscription" } });
  expect(screen.queryByRole("option", { name: "Funded Claude via Matrix AI" })).toBeNull();
  fireEvent.click(personalRow());
  expect(first.select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanceId: planId, driverKind: "matrix_pi", modelId: "gpt-owner", selectedOptions: planBinding }));
  first.unmount(); show(catalog, planId);
  expect(screen.getByRole("button", { name: "Matrix AI agent, Available" })).toHaveAttribute("aria-pressed", "true");
  expect(personalRow()).toHaveAttribute("aria-selected", "true"); expect(fundedRow()).toBeVisible();
  expect(screen.getByRole("searchbox")).not.toHaveFocus(); expect(screen.queryByRole("status")).toBeNull();
  expect(canonicalProviderModelRouteLabel(catalog.instances[1], "Owner GPT")).toBe("Owner GPT · Matrix AI · ChatGPT subscription");
});
it("keeps a selected disconnected subscription's recovery separate from available funded rows", () => {
  const catalog = groupedCatalog(), plan = catalog.instances[1]!;
  plan.availability = "auth_required"; plan.defaultSelection = undefined;
  plan.setupActions = [{ id: "connect_plan", kind: "open_settings", label: "Reconnect ChatGPT subscription" }];
  const { select, setup } = show(catalog, planId, planId);
  expect(personalRow()).toHaveAttribute("aria-selected", "true"); expect(personalRow()).toBeDisabled(); expect(fundedRow()).toBeDisabled();
  fireEvent.click(personalRow()); expect(select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reconnect ChatGPT subscription" }));
  expect(setup).toHaveBeenCalledExactlyOnceWith(plan, plan.setupActions[0]);
});
it.each([fundedId, planId])("keeps unselected unavailable source %s recoverable beside an available selected source", unavailableId => {
  const catalog = groupedCatalog(), source = catalog.instances.find(instance => instance.id === unavailableId)!;
  source.availability = unavailableId === fundedId ? "unavailable" : "auth_required";
  if (unavailableId === fundedId) source.connectionState = "credit_required";
  source.setupActions = [{ id: "recover_source", kind: "open_settings", label: "Recover source" }];
  const selectedId = unavailableId === fundedId ? planId : fundedId;
  const { select, setup } = show(catalog, selectedId, selectedId);
  const selectedRow = selectedId === planId ? personalRow() : fundedRow();
  expect(selectedRow).toHaveAttribute("aria-selected", "true"); expect(selectedRow).toBeEnabled();
  expect(screen.getByText(unavailableId === fundedId ? /^Matrix AI credit ·/ : /^ChatGPT subscription ·/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Recover source" }));
  expect(setup).toHaveBeenCalledExactlyOnceWith(source, source.setupActions[0]);
  expect(select).not.toHaveBeenCalled(); expect(selectedRow).toHaveAttribute("aria-selected", "true");
});
it.each([fundedId, planId])("keeps both unavailable sources recoverable with selected %s first and exact independent targets", selectedId => {
  const catalog = groupedCatalog(), plan = catalog.instances.find(instance => instance.id === planId)!;
  const funded = catalog.instances.find(instance => instance.id === fundedId)!;
  plan.availability = "auth_required"; funded.availability = "unavailable"; funded.connectionState = "credit_required";
  plan.setupActions = [{ id: "recover_plan", kind: "open_settings", label: "Recover ChatGPT" }];
  funded.setupActions = [{ id: "recover_funded", kind: "open_settings", label: "Recover Matrix credit" }];
  const { select, setup } = show(catalog, selectedId, selectedId);
  expect(personalRow()).toBeDisabled(); expect(fundedRow()).toBeDisabled();
  expect(screen.getByText(/^ChatGPT subscription ·/)).toBeVisible(); expect(screen.getByText(/^Matrix AI credit ·/)).toBeVisible();
  const buttons = screen.getAllByRole("button", { name: /^Recover/ });
  expect(buttons.map(button => button.textContent)).toEqual(selectedId === planId
    ? ["Recover ChatGPT", "Recover Matrix credit"] : ["Recover Matrix credit", "Recover ChatGPT"]);
  fireEvent.click(screen.getByRole("button", { name: "Recover ChatGPT" }));
  fireEvent.click(screen.getByRole("button", { name: "Recover Matrix credit" }));
  expect(setup.mock.calls).toEqual([[plan, plan.setupActions[0]], [funded, funded.setupActions[0]]]);
  expect(select).not.toHaveBeenCalled();
});
it("keeps reserved-credit recovery visible during loading and restores independent subscription recovery without changing selection", () => {
  const catalog = groupedCatalog(), plan = catalog.instances.find(instance => instance.id === planId)!;
  const funded = catalog.instances.find(instance => instance.id === fundedId)!;
  plan.availability = "auth_required"; funded.availability = "unavailable"; funded.connectionState = "credit_reserved";
  plan.setupActions = [{ id: "recover_plan", kind: "open_settings", label: "Recover ChatGPT" }];
  funded.setupActions = [{ id: "recover_funded", kind: "open_settings", label: "Recover Matrix credit" }];
  const select = vi.fn(), setup = vi.fn();
  const props = { catalog, choices: deriveCanonicalProviderChoices(catalog), selected: { instanceId: planId, modelId: "gpt-owner" },
    lockedInstanceId: planId, onSelect: select, onSetupAction: setup };
  const view = render(<CompactChatProviderChoices {...props} loading />);
  expect(screen.queryByRole("button", { name: "Recover ChatGPT" })).toBeNull();
  expect(screen.getByText("Your credit is reserved while usage is confirmed.")).toBeVisible();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no matching model" } });
  expect(screen.queryByRole("option")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Recover Matrix credit" }));
  expect(setup).toHaveBeenLastCalledWith(funded, funded.setupActions[0]);
  view.rerender(<CompactChatProviderChoices {...props} loading={false} />);
  expect(screen.queryByRole("option")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Recover ChatGPT" }));
  expect(setup).toHaveBeenLastCalledWith(plan, plan.setupActions[0]);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
  expect(personalRow()).toHaveAttribute("aria-selected", "true"); expect(personalRow()).toBeDisabled(); expect(fundedRow()).toBeDisabled();
  expect(select).not.toHaveBeenCalled();
});
it("keeps equal model IDs distinct by source and never copies subscription authority into a funded choice", () => {
  const catalog = groupedCatalog(), funded = catalog.instances.find(instance => instance.id === fundedId)!;
  funded.models[0]!.id = "gpt-owner"; funded.defaultSelection!.model = "gpt-owner";
  const { select } = show(catalog, planId);
  expect(personalRow()).toHaveAttribute("aria-selected", "true"); expect(fundedRow()).toHaveAttribute("aria-selected", "false");
  fireEvent.click(fundedRow());
  expect(select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanceId: fundedId, modelId: "gpt-owner", selectedOptions: [] }));
});
