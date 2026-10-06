// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat.js";
import { deriveCanonicalProviderChoices } from "../../../packages/ui/src/canonical-provider-choice.js";
import { MatrixBotModelField, matrixBotSelectableModelChoices, botModelChoiceMatchesSelection } from "../../../packages/ui/src/chat-agents/bots/MatrixBotModelField.js";
import { botModelRoutingLabel, canonicalProviderModelRouteLabel } from "@matrix-os/contracts";
import { deriveChatPickerEntries } from "../../../packages/ui/src/chat-picker-entries.js";
afterEach(cleanup);
const binding = [{ id: "accountId", value: "account-a" }, { id: "grantRevision", value: "3" }];
const selection = { instanceId: "matrix_chatgpt_plan", model: "gpt-owner", options: binding };
function catalog() {
  const value = createCanonicalProviderCatalogFixture(); const base = value.instances[0]!;
  value.instances = [{ ...base, id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Matrix AI", defaultSelection: { instanceId: "matrix_pi_default", model: base.models[0]!.id } },
    { ...base, id: selection.instanceId, driverKind: "matrix_bot", displayName: "ChatGPT subscription", connectionLabel: "ChatGPT subscription", defaultSelection: selection,
      options: binding.map(option => ({ id: option.id, label: option.id, kind: "enum" as const, values: [{ value: option.value, label: option.value }], defaultValue: option.value, placement: "advanced" as const })),
      supports: { ...base.supports, rootChat: false }, models: [{ ...base.models[0]!, id: selection.model, displayName: "Owner GPT" }] }];
  return value;
}
it("offers exact account-specific subscription models without a Pi suffix", () => {
  const value = catalog(); const choices = matrixBotSelectableModelChoices(deriveCanonicalProviderChoices(value), value);
  const plan = choices.find(row => row.instanceId === selection.instanceId)!;
  expect(plan).toBeDefined(); expect(plan.selectedOptions).toEqual(binding);
  expect(canonicalProviderModelRouteLabel(value.instances[1], "Owner GPT")).toBe("Owner GPT · ChatGPT subscription");
  expect(botModelRoutingLabel(selection, value)).toBe("ChatGPT subscription · Owner GPT");
});
it("shows Connection before source-specific models and clears model intent on deliberate source change", () => {
  const value = catalog(), change = vi.fn();
  render(<MatrixBotModelField selection={selection} catalog={value} models={deriveCanonicalProviderChoices(value)} pending={false} allowAutomatic={false} onChange={change}/>);
  expect(screen.getByRole("combobox", { name: "Connection" })).toHaveValue(selection.instanceId);
  expect(screen.getByRole("option", { name: "Owner GPT · ChatGPT subscription" })).toBeVisible();
  expect(within(screen.getByRole("combobox", { name: "Model" })).queryByRole("option", { name: /Matrix AI$/ })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Connection" }), { target: { value: "matrix_pi_default" } });
  expect(change).toHaveBeenCalledWith(null);
});
it("does not accept the same model from a replaced account or revoked grant", () => {
  const value = catalog(); const choices = deriveCanonicalProviderChoices(value); const plan = choices.find(row => row.instanceId === selection.instanceId)!;
  expect(botModelChoiceMatchesSelection(plan, selection)).toBe(true);
  expect(botModelChoiceMatchesSelection(plan, { ...selection, options: binding.map(row => row.id === "accountId" ? { ...row, value: "account-b" } : row) })).toBe(false);
  expect(botModelChoiceMatchesSelection(plan, { ...selection, options: binding.map(row => row.id === "grantRevision" ? { ...row, value: "4" } : row) })).toBe(false);
  expect(botModelChoiceMatchesSelection(plan, { ...selection, options: [] })).toBe(false);
});
it("retains an unavailable subscription selection without choosing Matrix AI", () => {
  const value = catalog(), change = vi.fn(); value.instances[1]!.availability = "unavailable";
  render(<MatrixBotModelField selection={selection} catalog={value} models={deriveCanonicalProviderChoices(value)} pending={false} allowAutomatic={false} onChange={change}/>);
  expect(screen.getByRole("combobox", { name: "Connection" })).toHaveValue(selection.instanceId);
  expect(screen.getByRole("option", { name: /gpt-owner · unavailable/ })).toBeVisible();
  expect(change).not.toHaveBeenCalled();
});
it("drops retained choices after the authoritative account or grant changes", () => {
  const value = catalog(), retained = deriveCanonicalProviderChoices(value);
  value.instances[1]!.defaultSelection = { ...selection, options: binding.map(row => row.id === "accountId" ? { ...row, value: "account-b" } : row) };
  expect(matrixBotSelectableModelChoices(retained, value).some(choice => choice.instanceId === selection.instanceId)).toBe(false);
});
it("hides the private Bot subscription source from ordinary Chat and generic New Agent choices", () => {
  const value = catalog(); value.instances[1]!.supports.rootChat = false;
  expect(deriveChatPickerEntries(value).flatMap(entry => entry.instances).some(instance => instance.id === selection.instanceId)).toBe(false);
  expect(matrixBotSelectableModelChoices(deriveCanonicalProviderChoices(value), value, false).some(choice => choice.instanceId === selection.instanceId)).toBe(false);
});

it("rejects a subscription descriptor with an unrelated harness driver", () => {
  const value = catalog(); value.instances[1]!.driverKind = "matrix_pi";
  expect(matrixBotSelectableModelChoices(deriveCanonicalProviderChoices(value), value).some(choice => choice.instanceId === selection.instanceId)).toBe(false);
});
