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
it("keeps equal model IDs distinct by source and never copies subscription authority into a funded choice", () => {
  const catalog = groupedCatalog(), funded = catalog.instances.find(instance => instance.id === fundedId)!;
  funded.models[0]!.id = "gpt-owner"; funded.defaultSelection!.model = "gpt-owner";
  const { select } = show(catalog, planId);
  expect(personalRow()).toHaveAttribute("aria-selected", "true"); expect(fundedRow()).toHaveAttribute("aria-selected", "false");
  fireEvent.click(fundedRow());
  expect(select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanceId: fundedId, modelId: "gpt-owner", selectedOptions: [] }));
});
