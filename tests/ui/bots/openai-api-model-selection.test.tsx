// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ordinaryOpenAiCatalog, openAiBinding } from "../ordinary-openai-api-fixture.js";
import { deriveCanonicalProviderChoices } from "../../../packages/ui/src/canonical-provider-choice.js";
import { AgentModelField } from "../../../packages/ui/src/chat-agents/AgentEditor.js";
import { MatrixBotModelField, matrixBotSelectableModelChoices, botModelChoiceMatchesSelection } from "../../../packages/ui/src/chat-agents/bots/MatrixBotModelField.js";
afterEach(cleanup);
it("the actual shared Bot field exposes OpenAI and preserves API, revision and generation", () => {
 const catalog = ordinaryOpenAiCatalog(true), choices = deriveCanonicalProviderChoices(catalog), change = vi.fn();
 const selection = { instanceId: "matrix_openai_api", model: "gpt-4.1", options: openAiBinding };
 const current = choices.find(choice => choice.instanceId === selection.instanceId)!;
 expect(matrixBotSelectableModelChoices(choices, catalog)).toContainEqual(current);
 render(<MatrixBotModelField selection={selection} catalog={catalog} models={choices} pending={false} allowAutomatic={false} onChange={change}/>);
 expect(screen.getByRole("combobox", { name: "Connection" })).toHaveValue(selection.instanceId);
 expect(screen.getByRole("option", { name: "gpt-4.1 · OpenAI API" })).toBeVisible();
 fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: JSON.stringify([selection.instanceId, selection.model, [...openAiBinding].sort((a,b) => a.id.localeCompare(b.id))]) } });
 expect(change).toHaveBeenCalledExactlyOnceWith(selection);
});
it("the shared Bot field denies stale key generations and disabled personal connections", () => {
 const catalog = ordinaryOpenAiCatalog(true), choices = deriveCanonicalProviderChoices(catalog), change = vi.fn();
 const choice = choices.find(c => c.instanceId === "matrix_openai_api")!;
 const selection = { instanceId: choice.instanceId, model: choice.modelId, options: openAiBinding.map(o => o.id === "connectionRevision" ? { ...o, value: "2" } : o) };
 expect(botModelChoiceMatchesSelection(choice, selection)).toBe(false);
 expect(matrixBotSelectableModelChoices(choices, catalog, false)).toEqual([]);
 render(<MatrixBotModelField selection={selection} catalog={catalog} models={choices} pending={false} allowAutomatic={false} onChange={change}/>);
 expect(screen.getByRole("option", { name: "gpt-4.1 · unavailable" })).toBeDisabled(); expect(change).not.toHaveBeenCalled();
});

it('keeps recipe-only OpenAI models out of the actual generic Agent field', () => {
 const catalog = ordinaryOpenAiCatalog(true), change = vi.fn();
 render(<AgentModelField id="custom" selected={{ instanceId: "codex_default", model: "saved" }} models={deriveCanonicalProviderChoices(catalog)} pending={false} hermesOnly={false} change={change}/>);
 expect(screen.queryAllByRole("option", { name: /OpenAI API/ })).toHaveLength(0); expect(change).not.toHaveBeenCalled();
});
