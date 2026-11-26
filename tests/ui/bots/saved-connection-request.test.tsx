// @vitest-environment jsdom
import React from "react";

import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BotChatPanel } from "../../../packages/ui/src/chat-agents/bots/BotChatPanel.js";
import { BotRunMessageBody } from "../../../packages/ui/src/chat-agents/bots/BotMessageBody.js";
import type { ChatAgentClient } from "../../../packages/ui/src/chat-agents/client.js";
import type { BotConnectionRequest, CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../../contracts/fixtures/canonical-chat.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";

function fixture({ inputActor = "user_fixture", sessionId = saved.id, resource = { kind: "integration", service: "gmail" } as BotConnectionRequest } = {}) {
  const { snapshot } = createCanonicalChatFixture("completed");
  const { project: _project, ...chat } = snapshot.chat;
  const run = { ...snapshot.runs[0]!, driverKind: "matrix_bot" as const, instanceId: "matrix_bot_default" };
  const request = { id: "activity_connect", type: "bot.connection.requested", chatId: chat.id, runId: run.id,
    occurredAt: run.createdAt, sessionId, baseDraftRevision: saved.revision, proposalId: "request_connect", resource } satisfies CanonicalChatDetailResponse["activities"][number];
  const detail: CanonicalChatDetailResponse = { record: { chat }, runs: [run], turns: snapshot.turns,
    messages: [{ ...snapshot.messages[0]!, actorId: inputActor }], activities: [request] };
  const base = clientFixture();
  base.list.mockResolvedValue({ enabled: true, agents: [saved] });
  base.integrations.mockResolvedValue([]);
  const fetchDetail = vi.fn(async () => detail);
  const mcpServers = vi.fn<NonNullable<ChatAgentClient["mcpServers"]>>().mockResolvedValue([]);
  const client = { ...base, mcpServers, setupChat: { detail: fetchDetail }, bots: {} } as unknown as ChatAgentClient;
  const open = vi.fn();
  const props = { client, chatId: chat.id, directBotId: saved.id, connectionRunId: run.id, onOpenResourceSettings: open };
  return { ...base, props, runId: run.id, fetchDetail, open, mcpServers };
}

afterEach(cleanup);

it("opens Settings only after an owner click, then reads live account state in the originating Bot run", async () => {
  const f = fixture();
  render(<BotChatPanel {...f.props}>
    <div aria-label="Other turn"><BotRunMessageBody runIds={["run_other"]}/></div>
    <div aria-label="Owner request"><BotRunMessageBody runIds={[f.runId]}/></div>
  </BotChatPanel>);
  const actionable = within(screen.getByLabelText("Owner request"));
  const connect = await actionable.findByRole("button", { name: /connect gmail/i });
  expect(within(screen.getByLabelText("Other turn")).queryByText(/gmail/i)).toBeNull();
  expect(f.open).not.toHaveBeenCalled();
  fireEvent.click(connect);
  expect(f.open).toHaveBeenCalledExactlyOnceWith("integrations");
  f.integrations.mockResolvedValue([{ service: "gmail", account_label: "Work", account_email: null, status: "active" }]);
  fireEvent.focus(window);
  await actionable.findByText(/connected/i);
  expect(f.update).not.toHaveBeenCalled();
});

it.each([{ inputActor: "another_owner" }, { sessionId: "bot_other" }])("ignores a connection activity with the wrong owner or Bot (%o)", async options => {
  const f = fixture(options);
  render(<BotChatPanel {...f.props}><BotRunMessageBody runIds={[f.runId]}/></BotChatPanel>);
  await waitFor(() => expect(f.fetchDetail).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button", { name: /connect gmail/i })).toBeNull();
  expect(f.integrations).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
});

it("updates the saved reply when Settings publishes an account change in the same window", async () => {
  const f = fixture();
  let onChange: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const view = render(<BotChatPanel {...f.props} subscribeToConnectionChanges={refresh => { onChange = refresh; return unsubscribe; }}>
    <BotRunMessageBody runIds={[f.runId]}/>
  </BotChatPanel>);
  await screen.findByRole("button", { name: /connect gmail/i });
  f.integrations.mockResolvedValue([{ service: "gmail", account_label: "Personal", account_email: null, status: "active" }]);
  act(() => onChange?.());
  await screen.findByText("Gmail is connected to Matrix.");
  f.integrations.mockRejectedValueOnce(new Error("unavailable"));
  act(() => onChange?.());
  await screen.findByText("Connection status could not be verified.");
  expect(screen.queryByText("Gmail is connected to Matrix.")).toBeNull();
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("opens MCP Settings and reads back the one named ready server on return", async () => {
  const f = fixture({ resource: { kind: "mcp", name: "Engineering docs" } });
  render(<BotChatPanel {...f.props}><BotRunMessageBody runIds={[f.runId]}/></BotChatPanel>);
  const open = await screen.findByRole("button", { name: /open mcp settings/i });
  await waitFor(() => expect(open).toHaveProperty("disabled", false));
  fireEvent.click(open);
  expect(f.open).toHaveBeenCalledExactlyOnceWith("mcp");
  f.mcpServers.mockResolvedValue([{ id: "docs", name: "Engineering docs", enabled: true, status: "ready" }]);
  fireEvent.focus(window);
  await screen.findByText("Engineering docs is ready on this computer.");
  expect(f.integrations).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
});

it("does not let a result from an earlier Chat survive a Chat switch", async () => {
  const f = fixture();
  const body = <BotRunMessageBody runIds={[f.runId]}/>;
  const view = render(<BotChatPanel {...f.props}>{body}</BotChatPanel>);
  await screen.findByRole("button", { name: /connect gmail/i });
  view.rerender(<BotChatPanel {...f.props} chatId="chat_other">{body}</BotChatPanel>);
  await waitFor(() => expect(f.fetchDetail).toHaveBeenLastCalledWith("chat_other"));
  expect(screen.queryByRole("button", { name: /connect gmail/i })).toBeNull();
  expect(f.open).not.toHaveBeenCalled();
});
