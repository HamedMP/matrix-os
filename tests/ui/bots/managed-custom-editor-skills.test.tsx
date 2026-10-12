// @vitest-environment jsdom
import React, { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ChatAgent, ChatAgentRecipe } from "@matrix-os/contracts";
import { AgentEditor, type AgentDraft } from "../../../packages/ui/src/chat-agents/AgentEditor.js";
import { deriveCanonicalProviderChoices } from "../../../packages/ui/src/canonical-provider-choice.js";
import { clientFixture, recipeCatalog, saved } from "../../desktop/chat-agents-fixture.js";

afterEach(cleanup);
const jev = "matrix-jev-email-triage";
const recipe: ChatAgentRecipe = { skills: [], integrations: [], output: "Keep the expected output" };
const managed: ChatAgent = { ...saved, selection: { instanceId: "matrix_bot_default", model: "auto" },
  recipeRef: { recipeId: "custom-coordinator", version: "1" }, recipe };

async function editor(editing: ChatAgent | "new", initialRecipe = recipe) {
  const catalog = await clientFixture().catalog();
  const onSave = vi.fn<(draft: AgentDraft) => Promise<void>>().mockResolvedValue(undefined);
  const onArchive = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const change = vi.fn();
  function Harness() {
    const [draft, setDraft] = useState<AgentDraft>({ name: "Keep my name", description: "Keep my description",
      instructions: "Keep my instructions", selection: editing === "new" ? saved.selection : editing.selection,
      requestId: "req_editor_skills", recipe: initialRecipe });
    return <AgentEditor draft={draft} editing={editing} pending={false} models={deriveCanonicalProviderChoices(catalog)}
      catalog={catalog} recipeCatalog={{ ...recipeCatalog, skills: [...recipeCatalog.skills,
        { id: jev, name: "Jev Inbox Triage", description: "Legacy Hermes workflow" }] }}
      connections={[]} recipeLoading={false} recipeError="" connectionError=""
      change={next => { change(next); setDraft(current => ({ ...current, ...next })); }}
      onSave={async () => { await onSave(draft); }} onArchive={onArchive} onBack={() => {}} onRetryRecipe={() => {}} />;
  }
  const result = render(<Harness />);
  return { ...result, onSave, onArchive, change };
}

it("offers supported skills but excludes Hermes-only Jev from managed custom editing", async () => {
  const x = await editor(managed);
  expect(screen.queryByRole("checkbox", { name: "Jev Inbox Triage" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Personal Daily Brief" }));
  expect(x.change).toHaveBeenLastCalledWith({ recipe: { ...recipe, skills: ["matrix-personal-daily-brief"] } });
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(x.onSave).toHaveBeenCalledTimes(1);
});

it("preserves an incompatible draft and blocks submission until the owner removes its unsupported skill", async () => {
  const retained = { ...recipe, skills: [jev, "matrix-personal-daily-brief"],
    integrations: [{ service: "gmail", accountLabel: "Keep my account" }], jevInboxLabeling: true };
  const x = await editor({ ...managed, recipe: retained }, retained);
  expect(x.change).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Keep my name");
  expect(screen.getByRole("textbox", { name: /Description/ })).toHaveValue("Keep my description");
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue("Keep my instructions");
  expect(screen.getByRole("textbox", { name: "Expected output" })).toHaveValue(retained.output);
  expect(screen.getByRole("combobox", { name: "Gmail account" })).toHaveValue("Keep my account");
  expect(screen.getByRole("checkbox", { name: "Personal Daily Brief" })).toBeChecked();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Remove the unavailable skill before saving this bot.");
  fireEvent.submit(x.container.querySelector("form")!);
  expect(x.onSave).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Archive Agent" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Archive Agent" }));
  expect(x.onArchive).toHaveBeenCalledTimes(1);
  expect(x.change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: `${jev} · unavailable` }));
  expect(x.change).toHaveBeenLastCalledWith({ recipe: { ...retained, skills: ["matrix-personal-daily-brief"] } });
  expect(screen.queryByRole("checkbox", { name: "Jev Inbox Triage" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(x.onSave).toHaveBeenCalledTimes(1);
  expect(x.onSave).toHaveBeenCalledWith({ name: "Keep my name", description: "Keep my description",
    instructions: "Keep my instructions", selection: managed.selection, requestId: "req_editor_skills",
    recipe: { ...retained, skills: ["matrix-personal-daily-brief"] } });
});

it.each(["new", "legacy"] as const)("retains selectable Jev in the %s Hermes editor", async kind => {
  const x = await editor(kind === "new" ? "new" : { ...saved, recipe });
  fireEvent.click(screen.getByRole("checkbox", { name: "Jev Inbox Triage" }));
  expect(screen.getByRole("checkbox", { name: "Jev Inbox Triage" })).toBeChecked();
  expect(x.change).toHaveBeenLastCalledWith({ recipe: { ...recipe, skills: [jev] } });
  const save = screen.getByRole("button", { name: kind === "new" ? "Create Agent" : "Save changes" });
  expect(save).toBeEnabled();
  fireEvent.click(save);
  expect(x.onSave).toHaveBeenCalledTimes(1);
});
