// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { BotCreationChatProps } from "../../packages/ui/src/chat-agents/BotCreationChat";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { CanonicalChatClient } from "../../desktop/src/renderer/src/lib/canonical-chat-client";
import { ElectronBotCreationChat } from "../../desktop/src/renderer/src/features/chat/ElectronBotCreationChat";
import { WebBotCreationChat } from "../../shell/src/components/chat/WebBotCreationChat";
import { clientFixture } from "./chat-agents-fixture";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function fixture() {
  const agents = clientFixture({ matrix: true }), catalog = await agents.catalog();
  const { snapshot } = createCanonicalChatFixture("completed");
  const detail: CanonicalChatDetailResponse = { record: { chat: snapshot.chat },
    turns: snapshot.turns, runs: snapshot.runs, activities: [...snapshot.activities, {
      id: "activity_proposal", chatId: snapshot.chat.id, runId: snapshot.runs[0]!.id, occurredAt: snapshot.chat.updatedAt,
      type: "bot.draft.proposed", proposalId: "proposal_creation", sessionId: "creation_session", baseDraftRevision: 3,
      patch: { name: "Actual proposal" },
    }], messages: [...snapshot.messages, { ...snapshot.messages[0]!, id: "msg_assistant_creation", seq: 2,
      role: "assistant", runId: snapshot.runs[0]!.id, parts: [{ type: "text", text: "Actual returned drafting result" }] }],
  };
  const client = { create: vi.fn(async () => detail.record), detail: vi.fn(async () => detail),
    getDetail: vi.fn(async () => detail), admitTurn: vi.fn(async () => ({ record: detail.record,
      turn: snapshot.turns[0]!, run: snapshot.runs[0]! })), cancelRun: vi.fn(async () => ({})) };
  const draft = { name: "", description: "", instructions: "", requestId: "req_draft", selection: catalog.instances[0]!.defaultSelection!, taskExecutor: null };
  const creation: BotCreationChatProps = { sessionId: "creation_session", revision: 3, seed: { kind: "scratch" },
    draft, taskExecutor: null, snapshot: { sessionId: "creation_session", draftRevision: 3, seed: { kind: "scratch" },
      draft: { name: "", description: "", instructions: "", selection: draft.selection, taskExecutor: null } },
    client: agents, catalog, models: [], pending: false, draftBar: <div data-testid="draft-controls"/>,
    isCurrent: () => true, applyDraftChange: vi.fn(() => true) };
  return { client, creation };
}
it.each(["Electron", "Web"])("%s sends through the original canonical client and projects only actual result/proposal", async surface => {
  const { client, creation } = await fixture();
  render(surface === "Electron" ? <ElectronBotCreationChat creation={creation} client={client as unknown as CanonicalChatClient}/>
    : <WebBotCreationChat creation={creation} client={client} connected/>);
  expect(screen.queryByText("Actual returned drafting result")).toBeNull();
  const input = screen.getByRole("textbox", { name: "Message chat" });
  expect(screen.getByTestId("draft-controls").compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  if (surface === "Electron") await setSharedComposerText(input, "Help configure my agent");
  else fireEvent.change(input, { target: { value: "Help configure my agent" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.admitTurn).toHaveBeenCalledTimes(1));
  expect(client.admitTurn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ botCreation: creation.snapshot,
    selection: { instanceId: "matrix_pi_default", model: "sonnet" } }));
  await waitFor(() => expect(screen.getByText("Actual returned drafting result")).toBeVisible());
  expect(creation.applyDraftChange).toHaveBeenCalledWith(3, { name: "Actual proposal" });
  await act(async () => {});
});
