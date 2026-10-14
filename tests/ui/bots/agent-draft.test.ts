import { describe, expect, it, vi } from "vitest";
import { copyAgentDraft, patchAgentDraft, type AgentDraft } from "../../../packages/ui/src/chat-agents/agent-draft.js";

const seed = (): AgentDraft => ({
  name: "Inbox", description: "Keep exact settings", instructions: "Summarize my inbox",
  requestId: "req_original",
  selection: { instanceId: "matrix_chatgpt_plan", model: "gpt-5.6-sol", options: [
    { id: "connection", value: "account_work" }, { id: "revision", value: "rev_12" },
    { id: "credential", value: "generation_8" }, { id: "thinking", value: false },
  ] },
  recipe: { skills: ["matrix-integrations", "matrix-personal-daily-brief"],
    integrations: [{ service: "gmail", accountLabel: "Work" }, { service: "google_calendar" }],
    output: "An actionable brief", jevInboxLabeling: false },
});

describe("canonical editable Agent draft", () => {
  it("owns full seed settings without sharing nested selection or recipe objects", () => {
    const source = seed(), draft = copyAgentDraft(source);
    expect(draft).toEqual(source);
    source.selection!.options![0]!.value = "different_account";
    source.recipe!.skills.push("another-skill");
    source.recipe!.integrations[0]!.accountLabel = "Personal";
    expect(draft).toEqual(seed());
  });

  it("copies externally supplied field patches and preserves untouched settings", () => {
    const current = seed(), replacement = seed();
    replacement.selection!.options![0]!.value = "new_account";
    replacement.recipe!.integrations[0]!.accountLabel = "Personal";
    const mint = vi.fn(() => "req_changed");
    const changed = patchAgentDraft(current, { selection: replacement.selection, recipe: replacement.recipe }, mint);
    replacement.selection!.options![0]!.value = "mutated";
    replacement.recipe!.integrations[0]!.accountLabel = "mutated";
    expect(changed.selection!.options![0]!.value).toBe("new_account");
    expect(changed.recipe!.integrations[0]!.accountLabel).toBe("Personal");
    expect(changed.instructions).toBe(current.instructions);
    expect(current).toEqual(seed());
    expect(changed.requestId).toBe("req_changed"); expect(mint).toHaveBeenCalledTimes(1);
  });

  it("keeps request identity for unchanged configuration, including equivalent copied settings", () => {
    const draft = seed(), mint = vi.fn(() => "req_changed");
    expect(patchAgentDraft(draft, {}, mint)).toBe(draft);
    expect(patchAgentDraft(draft, { name: draft.name, selection: copyAgentDraft(draft).selection,
      recipe: copyAgentDraft(draft).recipe }, mint)).toBe(draft);
    expect(mint).not.toHaveBeenCalled();
    const changed = patchAgentDraft(draft, { instructions: "Different instructions" }, mint);
    expect(changed.requestId).toBe("req_changed");
    expect(changed.recipe).toEqual(draft.recipe);
  });

  it("retains recipe omission, explicit undefined, configured recipe and explicit removal", () => {
    const withoutRecipe = seed(); delete withoutRecipe.recipe;
    expect(Object.hasOwn(copyAgentDraft(withoutRecipe), "recipe")).toBe(false);
    expect(Object.hasOwn(copyAgentDraft({ ...withoutRecipe, recipe: undefined }), "recipe")).toBe(true);
    const removed = patchAgentDraft(seed(), { recipe: null }, () => "req_removed");
    expect(removed.recipe).toBeNull();
    const unset = patchAgentDraft(removed, { recipe: undefined }, () => "req_unset");
    expect(unset.recipe).toBeUndefined(); expect(Object.hasOwn(unset, "recipe")).toBe(true);
    expect(patchAgentDraft(unset, { name: "Renamed" }, () => "req_name").recipe).toBeUndefined();
  });

  it("never copies gateway-stamped recipe authority or unrelated persisted fields", () => {
    const source = { ...seed(), recipeRef: { recipeId: "custom", version: "1" },
      recipe: { ...seed().recipe!, jevInboxTriage: { ownerId: "owner", connectionId: "connection" } } };
    const draft = copyAgentDraft(source);
    expect(draft).not.toHaveProperty("recipeRef");
    expect(draft.recipe).not.toHaveProperty("jevInboxTriage");
    expect(draft.recipe).toEqual(seed().recipe);
  });

  it("preserves incomplete selections and empty fields without parsing or defaulting them", () => {
    const empty = { name: "", description: "", instructions: "", selection: null, requestId: "req_empty" };
    expect(copyAgentDraft(empty)).toEqual(empty);
    expect(patchAgentDraft(empty, { description: "Partial draft" }, () => "req_partial").selection).toBeNull();
  });
});

it("does not perform a retained creation update after its owner scope expires during readback", async () => {
  const { recoverCreatedCustomBot } = await import("../../../packages/ui/src/chat-agents/recover-created-custom-bot.js");
  const { clientFixture, saved } = await import("../../desktop/chat-agents-fixture.js");
  const agent = { ...saved, recipeRef: { recipeId: "custom-coordinator", version: "1" } };
  const client = clientFixture();
  let resolve!: (value: { enabled: boolean; agents: typeof agent[] }) => void;
  client.list.mockImplementation(() => new Promise(done => { resolve = done; }));
  let current = true;
  const created = { agent: { id: agent.id, name: agent.name, avatarSeed: "a".repeat(32), revision: 1,
    status: "active" as const }, chatId: "chat_retained", operation: "created" as const };
  const pending = recoverCreatedCustomBot(client, created, { ...seed(), name: "Changed" }, () => current);
  current = false; resolve({ enabled: true, agents: [agent] });
  await pending;
  expect(client.update).not.toHaveBeenCalled();
});
