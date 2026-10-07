// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { deriveCanonicalProviderChoices } from "../../packages/ui/src/canonical-provider-choice.js";
import { deriveChatPickerEntries, deriveChatPickerModelRows } from "../../packages/ui/src/chat-picker-entries.js";
import { CompactChatProviderChoices } from "../../packages/ui/src/compact-chat-provider-choices.js";
import { createCanonicalComposerSelection, canonicalComposerSelectionIsAvailable } from "../../desktop/src/renderer/src/features/chat/canonical-composer-state";
import { ordinaryPlanCatalog, planBinding, planId } from "./ordinary-chatgpt-plan-fixture";
afterEach(cleanup);
it("projects a distinct Codex personal source and selects its observed model with exact binding", () => {
 const catalog = ordinaryPlanCatalog(), choices = deriveCanonicalProviderChoices(catalog), select = vi.fn();
 const plan = choices.find(choice => choice.instanceId === planId)!;
 expect(plan.harnessLabel).toBe("Codex · ChatGPT subscription");
 expect(deriveChatPickerEntries(catalog).find(entry => entry.id === planId)?.iconKind).toBe("codex");
 render(<CompactChatProviderChoices catalog={catalog} choices={choices} selected={plan} onSelect={select}/>);
 fireEvent.click(screen.getByRole("option", { name: "Owner GPT via Codex · ChatGPT subscription" }));
 expect(select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanceId: planId, modelId: "gpt-owner", selectedOptions: planBinding }));
 expect(screen.getByRole("searchbox", { name: "Search models and connections" })).not.toHaveFocus();
});
it("never automatically chooses personal subscription, while explicit qualified source works", () => {
 const catalog = ordinaryPlanCatalog();
 expect(createCanonicalComposerSelection(catalog)?.instanceId).not.toBe(planId);
 expect(createCanonicalComposerSelection(catalog, planId)?.options).toEqual(planBinding);
 expect(createCanonicalComposerSelection({ ...catalog, instances: [catalog.instances[1]!] })).toBeNull();
});
it.each(["account", "grant", "missing", "unavailable", "driver"])("rejects stale or unqualified %s model choices", boundary => {
 const catalog = ordinaryPlanCatalog(), choices = deriveCanonicalProviderChoices(catalog), plan = catalog.instances[1]!;
 if (boundary === "unavailable") plan.availability = "unavailable";
 else if (boundary === "driver") plan.driverKind = "codex";
 else if (boundary === "missing") plan.defaultSelection!.options = [];
 else plan.defaultSelection!.options = planBinding.map(option => option.id === (boundary === "account" ? "accountId" : "grantRevision") ? { ...option, value: boundary === "account" ? "account-b" : "4" } : option);
 expect(deriveChatPickerModelRows(catalog, choices).find(row => row.instanceId === planId)?.choice).toBeUndefined();
 expect(canonicalComposerSelectionIsAvailable(catalog, { instanceId: planId, model: "gpt-owner", options: planBinding, interactionMode: "default", permissionMode: "supervised" })).toBe(false);
});
it("shows unavailable personal models but prevents stale choice callbacks after disconnect", () => {
 const catalog = ordinaryPlanCatalog(), choices = deriveCanonicalProviderChoices(catalog), select = vi.fn();
 const plan = catalog.instances[1]!; plan.availability = "unavailable"; plan.defaultSelection = undefined;
 render(<CompactChatProviderChoices catalog={catalog} choices={choices} selected={{ instanceId: planId, modelId: "gpt-owner" }} onSelect={select}/>);
 const row = screen.getByRole("option", { name: "Owner GPT via Codex · ChatGPT subscription" });
 expect(row).toBeDisabled(); fireEvent.click(row); expect(select).not.toHaveBeenCalled();
 expect(createCanonicalComposerSelection(catalog, planId)).toBeNull();
});
it("does not allow cached personal choices without their qualifying catalog", () => {
 const choices = deriveCanonicalProviderChoices(ordinaryPlanCatalog()).filter(choice => choice.instanceId === planId);
 render(<CompactChatProviderChoices choices={choices} selected={choices[0]!} onSelect={vi.fn()}/>);
 expect(screen.queryByRole("option")).toBeNull();
});
it("selects observed native Claude Code models without inferring subscription or a Pi route", () => {
 const catalog = ordinaryPlanCatalog(), base = catalog.instances[0]!;
 catalog.drivers.push({ kind: "claude_code", displayName: "Claude Code", adapterVersion: "1.0.0", capabilityClass: "coding_agent" });
 catalog.instances.push({ ...base, id: "claude_code_default", driverKind: "claude_code", displayName: "Claude Code", connectionLabel: "Personal Claude account",
   defaultSelection: { instanceId: "claude_code_default", model: "observed-sonnet" }, models: [{ ...base.models[0]!, id: "observed-sonnet", displayName: "Observed Sonnet" }] });
 const choices = deriveCanonicalProviderChoices(catalog), select = vi.fn();
 render(<CompactChatProviderChoices catalog={catalog} choices={choices} selected={{ instanceId: "claude_code_default", modelId: "observed-sonnet" }} onSelect={select}/>);
 fireEvent.click(screen.getByRole("option", { name: "Observed Sonnet via Claude Code · Personal Claude account" }));
 expect(select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanceId: "claude_code_default", driverKind: "claude_code", modelId: "observed-sonnet", selectedOptions: [] }));
});
