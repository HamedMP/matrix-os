// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentModelField } from "../../packages/ui/src/chat-agents/AgentEditor.js";
import { deriveCanonicalProviderChoices } from "../../packages/ui/src/canonical-provider-choice.js";
import { CompactChatProviderChoices } from "../../packages/ui/src/compact-chat-provider-choices.js";
import { ordinaryPlanCatalog, planBinding, planId } from "./ordinary-chatgpt-plan-fixture.js";

afterEach(cleanup);

it("excludes the ordinary subscription route from custom Bots while keeping it explicitly selectable in ordinary Chat", () => {
  const catalog = ordinaryPlanCatalog(), choices = deriveCanonicalProviderChoices(catalog), change = vi.fn();
  const custom = render(<AgentModelField id="custom-model" selected={{ instanceId: "hermes_default", model: "saved-hermes" }} pending={false} models={choices} hermesOnly={false} change={change} />);
  expect(screen.queryByRole("option", { name: "Owner GPT · Codex · ChatGPT subscription" })).toBeNull();
  expect(change).not.toHaveBeenCalled();
  custom.unmount();
  const select = vi.fn(), plan = choices.find(choice => choice.instanceId === planId)!;
  render(<CompactChatProviderChoices catalog={catalog} choices={choices} selected={plan} onSelect={select} />);
  fireEvent.click(screen.getByRole("option", { name: "Owner GPT via Codex · ChatGPT subscription" }));
  expect(select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanceId: planId, modelId: "gpt-owner", selectedOptions: planBinding }));
});

it.each(["openai-codex:gpt-5.3-codex-spark", "openai-codex:gpt-5.6-sol"])("retains saved unavailable Hermes %s without selecting a subscription or another runtime", model => {
  const change = vi.fn(), catalog = ordinaryPlanCatalog();
  render(<AgentModelField id="saved-model" selected={{ instanceId: "hermes_default", model }} pending={false} models={deriveCanonicalProviderChoices(catalog)} hermesOnly={true} change={change} />);
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveProperty("value", JSON.stringify(["hermes_default", model]));
  expect(screen.getByRole("option", { name: `${model} · unavailable` })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "Owner GPT · Codex · ChatGPT subscription" })).toBeNull();
  expect(change).not.toHaveBeenCalled();
});
