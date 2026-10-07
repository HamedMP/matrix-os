// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat.js";
import { deriveCanonicalProviderChoices } from "../../../packages/ui/src/canonical-provider-choice.js";
import { MatrixBotModelField, matrixBotSelectableModelChoices, botModelChoiceMatchesSelection } from "../../../packages/ui/src/chat-agents/bots/MatrixBotModelField.js";
import { AgentEditor, AgentModelField } from "../../../packages/ui/src/chat-agents/AgentEditor.js";
import type { ChatAgent } from "@matrix-os/contracts";
afterEach(cleanup);
const options = [{ id: "connectionRevision", value: "3" }, { id: "credentialGeneration", value: "e16625fe-cad7-4983-a9db-e808bbf104cc" }];
const selection = { instanceId: "matrix_anthropic_api", model: "claude-owner", options };
function catalog() {
 const catalog = createCanonicalProviderCatalogFixture(), base = catalog.instances[0]!;
 const api = { ...base, id: selection.instanceId, driverKind: "matrix_bot" as const, displayName: "Claude · Anthropic API", connectionLabel: "Anthropic API", defaultSelection: selection,
 options: options.map(o => ({ id: o.id, label: o.id, kind: "enum" as const, values: [{ value: o.value, label: "Current connection" }], defaultValue: o.value, placement: "advanced" as const })),
 models: [{ ...base.models[0]!, id: selection.model, displayName: "Owner Claude" }], supports: { ...base.supports, rootChat: false } };
 catalog.instances = [api, { ...api, id: "matrix_pi_anthropic_api", driverKind: "matrix_pi", supports: { ...base.supports, rootChat: true }, defaultSelection: { ...selection, instanceId: "matrix_pi_anthropic_api" } }]; return catalog;
}
it("offers API-paid recipe connection and carries exact source binding when selected", () => {
 const c = catalog(), choices = deriveCanonicalProviderChoices(c), change = vi.fn();
 expect(matrixBotSelectableModelChoices(choices, c)).toHaveLength(1);
 render(<MatrixBotModelField selection={selection} catalog={c} models={choices} pending={false} allowAutomatic={false} onChange={change}/>);
 expect(screen.getByRole("combobox", { name: "Connection" })).toHaveValue(selection.instanceId);
 expect(screen.getByRole("option", { name: "Owner Claude · Anthropic API" })).toBeVisible();
 fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: JSON.stringify([selection.instanceId, selection.model, options]) } });
 expect(change).toHaveBeenCalledExactlyOnceWith(selection);
});
it("retains an unavailable saved generation without selecting a replacement key", () => {
 const c = catalog(), choices = deriveCanonicalProviderChoices(c), changed = { ...selection, options: [{ id: "connectionRevision", value: "4" }, options[1]!] }, change = vi.fn();
 expect(botModelChoiceMatchesSelection(choices[0]!, changed)).toBe(false);
 render(<MatrixBotModelField selection={changed} catalog={c} models={choices} pending={false} allowAutomatic={false} onChange={change}/>);
 expect(screen.getByRole("option", { name: "claude-owner · unavailable" })).toBeDisabled();
 expect(change).not.toHaveBeenCalled();
});
it("excludes unqualified API-paid routes from custom Bots", () => {
 const change = vi.fn();
 render(<AgentModelField id="custom" selected={{ instanceId: "hermes_default", model: "saved" }} models={deriveCanonicalProviderChoices(catalog())} pending={false} hermesOnly={false} change={change}/>);
 expect(screen.queryByRole("option", { name: /Owner Claude/ })).toBeNull(); expect(change).not.toHaveBeenCalled();
});

it("excludes API recipe connections from the helper and field when recipe connections are disabled", () => {
 const c = catalog(), choices = deriveCanonicalProviderChoices(c), change = vi.fn();
 expect(matrixBotSelectableModelChoices(choices, c, false)).toEqual([]);
 render(<MatrixBotModelField selection={null} catalog={c} models={choices} pending={false}
   allowAutomatic={false} allowSubscription={false} onChange={change}/>);
 expect(screen.queryByRole("option", { name: /Anthropic API/ })).toBeNull();
 expect(screen.queryByRole("option", { name: /Owner Claude/ })).toBeNull();
 expect(change).not.toHaveBeenCalled();
});

it.each(["new", "nonrecipe"] as const)("the actual %s Agent editor hides unsupported API models and refuses a changed API draft", kind => {
 const c = catalog(), change = vi.fn(), save = vi.fn();
 const editing = kind === "new" ? "new" : { id: "agent_test", revision: 1, selection: { instanceId: "codex_default", model: "prior-native" } } as ChatAgent;
 render(<AgentEditor editing={editing} draft={{ name: "API draft", description: "", instructions: "Write", requestId: "req_test", selection }}
   pending={false} models={deriveCanonicalProviderChoices(c)} catalog={c} recipeCatalog={null} connections={[]}
   recipeLoading={false} recipeError="" connectionError="" change={change} onSave={save}
   onArchive={vi.fn()} onBack={vi.fn()} onRetryRecipe={vi.fn()}/>);
 expect(screen.queryByRole("option", { name: /Anthropic API/ })).toBeNull();
 expect(screen.queryByRole("option", { name: /Owner Claude/ })).toBeNull();
 const submit = screen.getByRole("button", { name: kind === "new" ? "Create Agent" : "Save changes" });
 expect(submit).toBeDisabled(); fireEvent.submit(submit.closest("form")!);
 expect(save).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
});


it.each(["recipe", "saved nonrecipe"] as const)("preserves supported %s edits using their exact saved API selection", kind => {
 const c = catalog(), save = vi.fn(), change = vi.fn();
 const editing = { id: "agent_test", revision: 1, selection,
   ...(kind === "recipe" ? { recipeRef: { recipeId: "test", version: "1" } } : {}) } as ChatAgent;
 render(<AgentEditor editing={editing} draft={{ name: "Updated name", description: "", instructions: "Write", requestId: "req_test", selection }}
   pending={false} models={deriveCanonicalProviderChoices(c)} catalog={c} recipeCatalog={null} connections={[]}
   recipeLoading={false} recipeError="" connectionError="" change={change} onSave={save}
   onArchive={vi.fn()} onBack={vi.fn()} onRetryRecipe={vi.fn()}/>);
 if (kind === "recipe") expect(screen.getByRole("option", { name: "Owner Claude · Anthropic API" })).toBeVisible();
 else expect(screen.queryByRole("option", { name: "Owner Claude · Anthropic API" })).toBeNull();
 const submit = screen.getByRole("button", { name: "Save changes" });
 expect(submit).toBeEnabled(); fireEvent.submit(submit.closest("form")!);
 expect(save).toHaveBeenCalledOnce(); expect(change).not.toHaveBeenCalled();
});
