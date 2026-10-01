jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { BotRecipeChooser } from "@/components/BotRecipeChooser";
import { BotChatControls } from "@/components/BotChatControls";
import { createCanonicalProviderCatalogFixture } from "../../../tests/contracts/fixtures/canonical-chat";

beforeEach(() => jest.useFakeTimers());
afterEach(() => { act(() => jest.runOnlyPendingTimers()); cleanup(); jest.useRealTimers(); });

const selected = { instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" };
const catalog = createCanonicalProviderCatalogFixture();
const base = catalog.instances[0]!;
catalog.instances = [{ ...base, id: selected.instanceId, driverKind: "matrix_pi", displayName: "Pi", connectionLabel: "Matrix AI",
  models: [{ ...base.models[0]!, id: selected.model, displayName: "GLM 5.3 Flash" }] }];
const recipe = { recipeId: "writing-bot", version: "v1", name: "Writer", description: "Write drafts", output: "A draft" };

it("creates a Native Mobile recipe bot with the exact Matrix AI model", async () => {
  const create = jest.fn(async () => "chat_abcdefgh");
  render(<BotRecipeChooser recipes={[recipe]} catalog={catalog} onCreate={create} onOpenChat={jest.fn()} />);
  fireEvent.press(screen.getByText("GLM 5.3 Flash · Matrix AI · Pi"));
  fireEvent.press(screen.getByText("Build in Chat"));
  await waitFor(() => expect(create).toHaveBeenCalledWith({ recipeId: recipe.recipeId, version: recipe.version }, expect.any(String), selected));
});
it("retains an unavailable Native Mobile choice and blocks creation until deliberate change", () => {
  const create = jest.fn();
  const props = { recipes: [recipe], onCreate: create, onOpenChat: jest.fn() };
  const { rerender } = render(<BotRecipeChooser {...props} catalog={catalog} />);
  fireEvent.press(screen.getByText("GLM 5.3 Flash · Matrix AI · Pi"));
  rerender(<BotRecipeChooser {...props} catalog={{ ...catalog, instances: [] }} />);
  expect(screen.getByText(/saved Matrix AI model is unavailable/)).toBeTruthy();
  fireEvent.press(screen.getByText("Build in Chat"));
  expect(create).not.toHaveBeenCalled();
});
it("reads saved Matrix model intent in Native Mobile bot controls and shows unavailable state", () => {
  const snapshot = { agentId: "bot_abcdefgh", name: "Writer", selection: selected, interactions: [], tasks: [],
    authority: { agentId: "bot_abcdefgh", revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } } };
  render(<BotChatControls snapshot={snapshot} catalog={{ ...catalog, instances: [] }}
    onResolve={jest.fn()} onRevoke={jest.fn()} onMemory={jest.fn()} onRefresh={jest.fn()} />);
  expect(screen.getByText(`Runtime: Pi · Matrix AI · ${selected.model} · unavailable`)).toBeTruthy();
});

it("edits only the bot model through its revisioned Native Mobile action", async () => {
  const save = jest.fn(async () => undefined);
  const refresh = jest.fn();
  const snapshot = { agentId: "bot_abcdefgh", name: "Writer", revision: 2, selection: { instanceId: "matrix_bot_default", model: "auto" }, interactions: [], tasks: [],
    authority: { agentId: "bot_abcdefgh", revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } } };
  render(<BotChatControls snapshot={snapshot} catalog={catalog} onSelectionChange={save}
    onResolve={jest.fn()} onRevoke={jest.fn()} onMemory={jest.fn()} onRefresh={refresh} />);
  fireEvent.press(screen.getByText("GLM 5.3 Flash · Matrix AI · Pi"));
  await waitFor(() => expect(save).toHaveBeenCalledWith(selected));
  expect(refresh).toHaveBeenCalled();
});
