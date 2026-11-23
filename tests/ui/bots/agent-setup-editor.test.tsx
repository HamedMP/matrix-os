// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { CanonicalChatDetailResponse, CanonicalChatTurnAdmissionResponse, CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { ChatAgentsPanel } from "../../../packages/ui/src/chat-agents/ChatAgentsEntry.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";

afterEach(cleanup);
HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function() { this.removeAttribute("open"); };

const recipe = { skills: ["matrix-integrations"], integrations: [{ service: "gmail" }], output: "A private brief." };
const patch = { name: "Onboarding guide", instructions: "Draft a first-week brief for the owner.", recipe };
const now = "2026-11-23T08:00:00.000Z";

function fixture() {
  const client = clientFixture({ matrix: true });
  const detail: CanonicalChatDetailResponse = {
    record: {
      chat: {
        id: "chat_setup01", ownerScope: { type: "personal", ownerId: "owner" }, title: "Agent setup", lifecycle: "active",
        attention: "none", revision: 0, messageCount: 0, createdAt: now, updatedAt: now,
      }
    }, messages: [], turns: [], runs: [], activities: []
  };
  const admitted = { record: detail.record, run: { id: "run_setup01" } } as CanonicalChatTurnAdmissionResponse;
  const setupChat = {
    create: vi.fn(async () => detail.record), detail: vi.fn(async () => detail), cancelRun: vi.fn(),
    admitTurn: vi.fn(async (_id: string, input: CanonicalCreateChatTurnRequest) => {
      const snapshot = input.botCreation!;
      detail.activities = [{
        id: "activity_setup01", chatId: detail.record.chat.id, runId: admitted.run.id,
        occurredAt: now, type: "bot.draft.proposed", sessionId: snapshot.sessionId, baseDraftRevision: snapshot.draftRevision,
        proposalId: "proposal_setup01", patch
      }];
      detail.runs = [{ ...admitted.run, status: "completed" }];
      return admitted;
    }),
  };
  return { ...client, setupChat };
}

function send() {
  fireEvent.change(screen.getByRole("textbox", { name: "Message about this agent" }), { target: { value: "Help me onboard new colleagues with Gmail." } });
  fireEvent.click(screen.getByRole("button", { name: "Send setup message" }));
}

it("previews a real scoped proposal in the scratch form and creates only after the owner confirms", async () => {
  const client = fixture();
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start from scratch" }));
  send();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(patch.instructions));
  expect(client.create).not.toHaveBeenCalled();
  expect(client.setupChat.admitTurn.mock.calls[0]![1].botCreation?.choices?.services).toEqual(["gmail", "google_calendar"]);
  expect(JSON.stringify(client.setupChat.admitTurn.mock.calls[0]![1])).not.toContain("work@example.test");
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => expect(client.create).toHaveBeenCalledTimes(1));
  expect(client.create).toHaveBeenCalledWith(expect.objectContaining(patch));
});

it("discarding a proposed edit preserves saved instructions, and reopening permits a fresh explicit Save", async () => {
  const client = fixture();
  client.list.mockResolvedValue({ enabled: true, agents: [saved] as never[] });
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit Meeting helper" }));
  send();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(patch.name));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(client.update).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "Edit Meeting helper" }));
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(saved.instructions);
  send();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(patch.name));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(client.update).toHaveBeenCalledTimes(1));
  expect(client.update).toHaveBeenCalledWith(saved.id, expect.objectContaining({ baseRevision: saved.revision, ...patch }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit Onboarding guide" }));
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(patch.instructions);
});

it("ignores an old proposal after a manual edit while the drafting run is in flight", async () => {
  const client = fixture();
  let release!: () => void;
  const admit = client.setupChat.admitTurn.getMockImplementation()!;
  client.setupChat.admitTurn.mockImplementationOnce(async (...args) => {
    await new Promise<void>(resolve => { release = resolve; }); return admit(...args);
  });
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start from scratch" }));
  send();
  await waitFor(() => expect(client.setupChat.admitTurn).toHaveBeenCalled());
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "My own revision" } });
  await act(async () => release());
  await screen.findByText(/configuration changed while Matrix AI was drafting/i);
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("My own revision");
  expect(client.create).not.toHaveBeenCalled();
});
