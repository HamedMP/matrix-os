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
const question = "Which group should this agent help first?";
const suggestedReplies = ["New colleagues", "Support agents"];
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
  let turn = 0;
  const setupChat = {
    create: vi.fn(async () => {
      detail.messages = []; detail.runs = []; detail.activities = [];
      return structuredClone(detail.record);
    }), detail: vi.fn(async () => structuredClone(detail)), cancelRun: vi.fn(),
    admitTurn: vi.fn(async (_id: string, input: CanonicalCreateChatTurnRequest) => {
      const snapshot = input.botCreation!;
      turn++;
      const admitted = { record: detail.record, run: { id: `run_setup0${turn}` }, message: { id: `msg_setup_owner${turn}` } } as CanonicalChatTurnAdmissionResponse;
      detail.messages.push({ id: admitted.message.id, chatId: detail.record.chat.id, runId: admitted.run.id, createdAt: now, seq: detail.messages.length + 1,
        role: "user", state: "committed", parts: input.parts });
      if (snapshot.intent === "open") {
        detail.messages.push({ id: `msg_setup_agent${turn}`, chatId: detail.record.chat.id, runId: admitted.run.id, createdAt: now, seq: detail.messages.length + 1,
          role: "assistant", state: "committed", parts: [{ type: "text", text: question }] });
        detail.activities = [{ id: `activity_setup0${turn}`, chatId: detail.record.chat.id, runId: admitted.run.id, occurredAt: now, type: "bot.setup.question",
          sessionId: snapshot.sessionId, baseDraftRevision: snapshot.draftRevision, proposalId: `proposal_setup0${turn}`, question, suggestedReplies }];
      } else detail.activities = [{
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
  render(<React.StrictMode><ChatAgentsPanel client={client} onClose={vi.fn()}/></React.StrictMode>);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start from scratch" }));
  expect(await screen.findByText(question)).toBeVisible();
  expect(screen.getAllByText(question)).toHaveLength(1);
  expect(screen.queryByText("Start agent setup.")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "New colleagues" }));
  expect(await screen.findByText(patch.instructions)).toBeVisible();
  expect(client.create).not.toHaveBeenCalled();
  expect(screen.queryByRole("group", { name: "Suggested replies" })).toBeNull();
  expect(client.setupChat.admitTurn).toHaveBeenCalledTimes(2);
  expect(client.setupChat.admitTurn.mock.calls[1]![1]).toMatchObject({ parts: [{ type: "text", text: "New colleagues" }], botCreation: { intent: "reply" } });
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
  await screen.findByRole("button", { name: "New colleagues" });
  send();
  expect(await screen.findByText(patch.instructions)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(client.update).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "Edit Meeting helper" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review configuration" }));
  expect(screen.getByText(saved.instructions)).toBeVisible();
  await screen.findByRole("button", { name: "New colleagues" });
  send();
  expect(await screen.findByText(patch.instructions)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(client.update).toHaveBeenCalledTimes(1));
  expect(client.update).toHaveBeenCalledWith(saved.id, expect.objectContaining({ baseRevision: saved.revision, ...patch }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit Onboarding guide" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review configuration" }));
  expect(screen.getByText(patch.instructions)).toBeVisible();
});

it("ignores an old proposal after a manual edit while the drafting run is in flight", async () => {
  const client = fixture();
  let release!: () => void;
  const admit = client.setupChat.admitTurn.getMockImplementation()!;
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start from scratch" }));
  await screen.findByRole("button", { name: "New colleagues" });
  client.setupChat.admitTurn.mockImplementationOnce(async (...args) => {
    await new Promise<void>(resolve => { release = resolve; }); return admit(...args);
  });
  send();
  await waitFor(() => expect(client.setupChat.admitTurn).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Review configuration" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit configuration" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "My own revision" } });
  await act(async () => release());
  await screen.findByText(/configuration changed while Matrix AI was drafting/i);
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("My own revision");
  expect(client.create).not.toHaveBeenCalled();
});

it("waits for scoped resources and retains the same unsaved setup when opening resource settings", async () => {
  const client = fixture();
  const onOpenResourceSettings = vi.fn();
  let load!: () => void;
  const loadDevices = client.integrations.getMockImplementation()!;
  client.integrations.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { load = resolve; });
    return loadDevices();
  });
  const view = render(<ChatAgentsPanel client={client} onClose={vi.fn()} onOpenResourceSettings={onOpenResourceSettings}/>);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start from scratch" }));
  expect(client.setupChat.admitTurn).not.toHaveBeenCalled();
  await act(async () => load());
  await screen.findByRole("button", { name: "New colleagues" });
  fireEvent.click(screen.getByRole("button", { name: "Review configuration" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit configuration" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "My unsaved helper" } });
  fireEvent.click(screen.getByRole("button", { name: "MCP settings" }));
  expect(onOpenResourceSettings).toHaveBeenCalledWith("mcp");
  fireEvent.click(screen.getByRole("button", { name: "Integration settings" }));
  expect(onOpenResourceSettings).toHaveBeenCalledWith("integrations");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(client.integrations).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Check resources" }));
  await waitFor(() => expect(client.integrations).toHaveBeenCalledTimes(3));
  view.rerender(<ChatAgentsPanel client={client} onClose={vi.fn()} onOpenResourceSettings={onOpenResourceSettings}/>);
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("My unsaved helper");
  expect(client.setupChat.create).toHaveBeenCalledTimes(1);
  expect(client.setupChat.admitTurn).toHaveBeenCalledTimes(1);
  expect(client.create).not.toHaveBeenCalled();
});
