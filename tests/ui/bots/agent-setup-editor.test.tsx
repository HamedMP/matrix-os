// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { CanonicalChatDetailResponse, CanonicalChatTurnAdmissionResponse, CanonicalCreateChatTurnRequest, BotCreationDraftPatch } from "@matrix-os/contracts";
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

function fixture(modelPatch: BotCreationDraftPatch = patch, recap?: string,
  requestedResource?: { kind: "integration"; service: string } | { kind: "mcp"; name?: string }) {
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
      const turnId = `turn_setup0${turn}`;
      detail.messages.push({ id: admitted.message.id, chatId: detail.record.chat.id, turnId, actorId: "owner", createdAt: now, seq: detail.messages.length + 1,
        role: "user", state: "committed", parts: input.parts });
      detail.turns.push({ id: turnId, chatId: detail.record.chat.id, inputMessageId: admitted.message.id } as CanonicalChatDetailResponse["turns"][number]);
      if (snapshot.intent === "open") {
        detail.messages.push({ id: `msg_setup_agent${turn}`, chatId: detail.record.chat.id, runId: admitted.run.id, createdAt: now, seq: detail.messages.length + 1,
          role: "assistant", state: "committed", parts: [{ type: "text", text: "I reviewed the whole draft. " + question }] });
        detail.activities = [{ id: `activity_setup0${turn}`, chatId: detail.record.chat.id, runId: admitted.run.id, occurredAt: now, type: "bot.setup.question",
          sessionId: snapshot.sessionId, baseDraftRevision: snapshot.draftRevision, proposalId: `proposal_setup0${turn}`, question, suggestedReplies }];
      } else if (requestedResource) detail.activities = [{
        id: "activity_connect01", chatId: detail.record.chat.id, runId: admitted.run.id, occurredAt: now,
        type: "bot.connection.requested", sessionId: snapshot.sessionId,
        baseDraftRevision: snapshot.draftRevision, resource: requestedResource,
      } as CanonicalChatDetailResponse["activities"][number]];
      else detail.activities = [{
        id: "activity_setup01", chatId: detail.record.chat.id, runId: admitted.run.id,
        occurredAt: now, type: "bot.draft.proposed", sessionId: snapshot.sessionId, baseDraftRevision: snapshot.draftRevision,
        proposalId: "proposal_setup01", patch: modelPatch
      }];
      if (snapshot.intent === "reply" && recap) detail.messages.push({
        id: `msg_setup_confirm${turn}`, chatId: detail.record.chat.id, runId: admitted.run.id, createdAt: now, seq: detail.messages.length + 1,
        role: "assistant", state: "committed", parts: [{ type: "text", text: recap }],
      });
      detail.runs = [{ ...admitted.run, chatId: detail.record.chat.id, turnId, status: "completed" }];
      return admitted;
    }),
  };
  return { ...client, setupChat };
}

function send(text = "Help me onboard new colleagues with Gmail.") {
  fireEvent.change(screen.getByRole("textbox", { name: "Message about this agent" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send setup message" }));
}

it("opens the existing app settings only on click and reports the newly active account on return", async () => {
  const client = fixture(patch, undefined, { kind: "integration", service: "gmail" });
  client.integrations.mockResolvedValue([]);
  const open = vi.fn();
  render(<ChatAgentsPanel client={client} onOpenResourceSettings={open} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start from scratch" }));
  await screen.findByRole("button", { name: "New colleagues" });
  send("Connect my Gmail.");
  const connect = await screen.findByRole("button", { name: "Connect Gmail" });
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByText("Gmail is connected to Matrix.")).toBeNull();
  fireEvent.click(connect);
  expect(open).toHaveBeenCalledWith("integrations");
  client.integrations.mockResolvedValue([{ service: "gmail", account_label: "Work", account_email: null, status: "active" }]);
  fireEvent.focus(window);
  await screen.findByText("Gmail is connected to Matrix.");
  fireEvent.click(screen.getByRole("button", { name: "Choose for this Agent" }));
  expect(screen.getByRole("region", { name: "Choose integrations" })).toBeVisible();
  expect(client.create).not.toHaveBeenCalled();
  expect(client.update).not.toHaveBeenCalled();
});

it("routes a chat-requested MCP connection to the existing MCP settings", async () => {
  const client = fixture(patch, undefined, { kind: "mcp" });
  const open = vi.fn();
  render(<ChatAgentsPanel client={client} onOpenResourceSettings={open} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start from scratch" }));
  await screen.findByRole("button", { name: "New colleagues" });
  send("I want to add an MCP server.");
  fireEvent.click(await screen.findByRole("button", { name: "Open MCP settings" }));
  expect(open).toHaveBeenCalledWith("mcp");
  expect(client.create).not.toHaveBeenCalled();
});

it("does not offer a connection action for a service missing from the catalog", async () => {
  const client = fixture(patch, "You can check your connections in Settings.",
    { kind: "integration", service: "unlisted_service" });
  const open = vi.fn();
  render(<ChatAgentsPanel client={client} onOpenResourceSettings={open} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start from scratch" }));
  await screen.findByRole("button", { name: "New colleagues" });
  send("Connect this service.");
  await screen.findByText("You can check your connections in Settings.");
  expect(screen.queryByRole("region", { name: /connect .* from chat/i })).toBeNull();
  expect(open).not.toHaveBeenCalled();
});

it("reports the specified MCP server ready only after the Settings readback matches", async () => {
  const mcpServers = vi.fn<NonNullable<Parameters<typeof ChatAgentsPanel>[0]["client"]["mcpServers"]>>()
    .mockResolvedValue([]);
  const client = { ...fixture(patch, undefined, { kind: "mcp", name: "Handbook" }), mcpServers };
  const open = vi.fn();
  render(<ChatAgentsPanel client={client} onOpenResourceSettings={open} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start from scratch" }));
  await screen.findByRole("button", { name: "New colleagues" });
  send("Connect my Handbook MCP.");
  const settings = await screen.findByRole("button", { name: "Open MCP settings" });
  await waitFor(() => expect(settings).toBeEnabled());
  fireEvent.click(settings);
  mcpServers.mockResolvedValue([{ id: "mcp_handbook", name: "Handbook", status: "ready", enabled: true }]);
  fireEvent.focus(window);
  await screen.findByText("Handbook is ready on this computer.");
  expect(open).toHaveBeenCalledExactlyOnceWith("mcp");
});

it("previews a real scoped proposal in the scratch form and creates only after the owner confirms", async () => {
  const recap = "Named the agent Onboarding guide and added Gmail to the brief.";
  const client = fixture(patch, recap);
  render(<React.StrictMode><ChatAgentsPanel client={client} onClose={vi.fn()}/></React.StrictMode>);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start from scratch" }));
  expect(await screen.findByText(question)).toBeVisible();
  const progress = screen.getByRole("navigation", { name: "Agent setup progress" });
  expect(within(progress).getByText("Discuss").closest("li")).toHaveAttribute("aria-current", "step");
  expect(screen.getAllByText(question)).toHaveLength(1);
  expect(screen.queryByText(/I reviewed the whole draft/)).toBeNull();
  expect(screen.queryByText("Start agent setup.")).toBeNull();
  const answer = await screen.findByRole("button", { name: "New colleagues" });
  await waitFor(() => expect(answer).toBeEnabled());
  fireEvent.click(answer);
  await screen.findByRole("region", { name: "Configuration preview" });
  expect(within(progress).getByText("Review").closest("li")).toHaveAttribute("aria-current", "step");
  expect(screen.queryByRole("button", { name: "Earlier messages" })).toBeNull();
  expect(screen.queryByText(patch.instructions)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Configuration details" }));
  expect(screen.getByText(patch.instructions)).toBeVisible();
  expect(screen.getByText(recap)).toBeVisible();
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

it("adds installed skills and a specific connected account from setup before explicit creation", async () => {
  const client = fixture({ name: patch.name, instructions: patch.instructions });
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start from scratch" }));
  await screen.findByText(question);

  fireEvent.click(screen.getByRole("button", { name: "Add skills" }));
  expect(within(screen.getByRole("navigation", { name: "Agent setup progress" })).getByText("Resources").closest("li")).toHaveAttribute("aria-current", "step");
  let picker = within(screen.getByRole("region", { name: "Choose skills" }));
  fireEvent.click(picker.getByRole("checkbox", { name: "Matrix integrations" }));
  fireEvent.click(picker.getByRole("button", { name: "Cancel resource changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Add skills" }));
  picker = within(screen.getByRole("region", { name: "Choose skills" }));
  expect(picker.getByRole("checkbox", { name: "Matrix integrations" })).not.toBeChecked();
  fireEvent.click(picker.getByRole("checkbox", { name: "Matrix integrations" }));
  fireEvent.change(picker.getByRole("textbox", { name: "Expected output" }), { target: { value: "A private brief." } });
  fireEvent.click(picker.getByRole("button", { name: "Add to configuration" }));

  fireEvent.click(screen.getByRole("button", { name: "Add integrations" }));
  picker = within(screen.getByRole("region", { name: "Choose integrations" }));
  fireEvent.change(picker.getByRole("combobox", { name: "Add integration" }), { target: { value: "gmail" } });
  fireEvent.change(picker.getByRole("combobox", { name: "Gmail account" }), { target: { value: "Work" } });
  fireEvent.click(picker.getByRole("button", { name: "Add to configuration" }));
  expect(screen.getByText("Gmail · Work")).toBeVisible();
  expect(screen.getByText(question)).toBeVisible();
  expect(screen.getByPlaceholderText("Write your own answer…")).toBeVisible();
  expect(screen.queryByRole("group", { name: "Suggested replies" })).toBeNull();
  expect(client.create).not.toHaveBeenCalled();
  expect(client.setupChat.admitTurn).toHaveBeenCalledTimes(1);

  send();
  await screen.findByRole("region", { name: "Configuration preview" });
  const expectedRecipe = { ...recipe, integrations: [{ service: "gmail", accountLabel: "Work" }] };
  expect(client.setupChat.admitTurn.mock.calls[1]?.[1].botCreation?.draft.recipe).toMatchObject(expectedRecipe);
  expect(client.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => expect(client.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ recipe: expectedRecipe })));
});

it("opens saved settings without restarting setup and preserves manual edits only on Save", async () => {
  const client = fixture();
  client.list.mockResolvedValue({ enabled: true, agents: [saved] as never[] });
  const onClose = vi.fn();
  const view = render(<ChatAgentsPanel client={client} onClose={onClose} requestedAgentId={saved.id}/>);
  expect(await screen.findByRole("textbox", { name: "Instructions" })).toHaveValue(saved.instructions);
  expect(screen.queryByRole("button", { name: "Edit with chat" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Unsaved" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(client.update).not.toHaveBeenCalled();
  view.unmount();
  render(<ChatAgentsPanel client={client} onClose={onClose}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Edit Meeting helper" }));
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(saved.instructions);
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: patch.instructions } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(client.update).toHaveBeenCalledWith(saved.id, expect.objectContaining({ baseRevision: saved.revision, instructions: patch.instructions })));
  expect(client.setupChat.admitTurn).not.toHaveBeenCalled();
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
  const priorConnections = await loadDevices();
  client.integrations.mockResolvedValueOnce([...priorConnections, {
    service: "gmail", account_label: "New inbox", account_email: "new@example.test", status: "active",
  }]);
  fireEvent.click(screen.getByRole("button", { name: "Review configuration" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit configuration" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "My unsaved helper" } });
  fireEvent.click(screen.getByRole("button", { name: "MCP settings" }));
  expect(onOpenResourceSettings).toHaveBeenCalledWith("mcp");
  fireEvent.click(screen.getByRole("button", { name: "Add skills" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Skills settings" }));
  expect(onOpenResourceSettings).toHaveBeenCalledWith("skills");
  fireEvent.click(screen.getByRole("button", { name: "Add integrations" }));
  fireEvent.click(screen.getByRole("button", { name: "Connect an app" }));
  expect(onOpenResourceSettings).toHaveBeenCalledWith("integrations");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(client.integrations).toHaveBeenCalledTimes(2);
  const picker = within(screen.getByRole("region", { name: "Choose integrations" }));
  fireEvent.change(picker.getByRole("combobox", { name: "Add integration" }), { target: { value: "gmail" } });
  expect(picker.getByRole("option", { name: "New inbox · new@example.test" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Check resources" }));
  await waitFor(() => expect(client.integrations).toHaveBeenCalledTimes(3));
  view.rerender(<ChatAgentsPanel client={client} onClose={vi.fn()} onOpenResourceSettings={onOpenResourceSettings}/>);
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("My unsaved helper");
  expect(client.setupChat.create).toHaveBeenCalledTimes(1);
  expect(client.setupChat.admitTurn).toHaveBeenCalledTimes(1);
  expect(client.create).not.toHaveBeenCalled();
});

it("reviews only the latest actual change and preserves the complete draft behind a disclosure", async () => {
  const client = fixture({ name: patch.name, instructions: patch.instructions });
  client.list.mockResolvedValue({ enabled: true, agents: [saved] as never[] });
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start from scratch" }));
  await screen.findByRole("button", { name: "New colleagues" });
  send();
  expect(await screen.findByText("Updated name and instructions.")).toBeVisible();
  expect(screen.queryByText(patch.instructions)).toBeNull();
  expect(screen.getByRole("button", { name: "Create Agent" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Configuration details" }));
  expect(screen.getByText(patch.instructions)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Edit configuration" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: saved.instructions } });
  expect(screen.queryByText("Updated name and instructions.")).toBeNull();
  expect(client.update).not.toHaveBeenCalled();
});
