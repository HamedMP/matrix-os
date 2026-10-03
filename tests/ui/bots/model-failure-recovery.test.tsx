// @vitest-environment jsdom
import React, { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotModelRecoveryProvider, useBotModelRecovery } from "../../../packages/ui/src/chat-agents/bots/BotModelRecovery.js";
import { BotChatPanel } from "../../../packages/ui/src/chat-agents/bots/BotChatPanel.js";
import { ConversationTranscript } from "../../../desktop/src/renderer/src/components/conversation/transcript.js";
import type { ConversationTurnPresentation } from "../../../desktop/src/renderer/src/components/conversation/presentation.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";
const turn: ConversationTurnPresentation = { id: "turn_1", active: false, startedAt: 1, endedAt: 2, work: [], final: {
  kind: "notice", id: "failure_1", phase: "final", tone: "failed", failureCode: "model_unavailable", label: "Agent work failed",
  markdown: "The selected model is unavailable. Choose another model.", timestamp: 2,
  actions: [{ kind: "retry", turnId: "turn_1", label: "Retry" }],
} };
beforeEach(() => { globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("replaces the Bot canonical failure once with contained actions and opens its own Details without retrying", async () => {
  const client = clientFixture(), performAction = vi.fn(), setup = vi.fn(), refresh = vi.fn();
  client.list.mockResolvedValue({ enabled: true, agents: [saved] });
  client.bots = { interactions: vi.fn(async () => []), tasks: vi.fn(async () => []), authority: vi.fn(async () => ({ grants: [], connections: [], memory: { items: [] }, routines: [], pendingInteractions: [] })) } as never;
  render(<BotModelRecoveryProvider agentId={saved.id} client={client} onSetup={setup} onRefreshCatalog={refresh}>
    <BotChatPanel chatId="chat_bot" directBotId={saved.id} client={client}/>
    <ConversationTranscript turns={[turn]} callbacks={{ copyText: vi.fn(), performAction }}/>
  </BotModelRecoveryProvider>);
  await screen.findByText(saved.name);
  expect(screen.getAllByRole("status", { name: "Bot model unavailable" })).toHaveLength(1);
  expect(screen.queryByText("Agent work failed")).toBeNull();
  expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
  expect(screen.getByRole("complementary", { name: "Bot details" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check availability" })); expect(refresh).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Agents & providers" })); expect(setup).toHaveBeenCalledOnce();
  expect(performAction).not.toHaveBeenCalled(); expect(client.update).not.toHaveBeenCalled();
});
it("preserves ordinary/unresolved failure behavior and limits Bot recovery to the model code", () => {
  const client = clientFixture(), callbacks = { copyText: vi.fn(), performAction: vi.fn() };
  const view = render(<BotModelRecoveryProvider client={client}><ConversationTranscript turns={[turn]} callbacks={callbacks}/></BotModelRecoveryProvider>);
  expect(screen.getByRole("status", { name: "Agent work failed" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Choose model" })).toBeNull();
  const other = { ...turn, final: { ...turn.final!, failureCode: "run_failed" as const } } as ConversationTurnPresentation;
  view.rerender(<BotModelRecoveryProvider agentId={saved.id} client={client}><ConversationTranscript turns={[other]} callbacks={callbacks}/></BotModelRecoveryProvider>);
  expect(screen.getByRole("status", { name: "Agent work failed" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Choose model" })).toBeNull();
});
it("does not carry a Details request into another client or Bot", async () => {
  const client = clientFixture(), next = clientFixture();
  let oldChoose!: () => void;
  function Probe() { const recovery = useBotModelRecovery(); useEffect(() => { if (recovery?.client === client) oldChoose = recovery.chooseModel; }, [recovery]); return <><button onClick={() => recovery?.chooseModel()}>Choose</button><output data-testid="request">{recovery?.detailsRequest?.sequence ?? "none"}</output></>; }
  const view = render(<BotModelRecoveryProvider agentId={saved.id} client={client}><Probe/></BotModelRecoveryProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Choose" }));
  await waitFor(() => expect(screen.getByTestId("request").textContent).toBe("1"));
  const retainedChoose = oldChoose;
  view.rerender(<BotModelRecoveryProvider agentId={saved.id} client={next}><Probe/></BotModelRecoveryProvider>);
  expect(screen.getByTestId("request").textContent).toBe("none");
  fireEvent.click(screen.getByRole("button", { name: "Choose" }));
  const newRequest = screen.getByTestId("request").textContent;
  act(() => retainedChoose());
  expect(screen.getByTestId("request").textContent).toBe(newRequest);
  view.rerender(<BotModelRecoveryProvider agentId={saved.id} client={client}><Probe/></BotModelRecoveryProvider>);
  expect(screen.getByTestId("request").textContent).toBe("none");
  view.rerender(<BotModelRecoveryProvider agentId="bot_other" client={client}><Probe/></BotModelRecoveryProvider>);
  expect(screen.getByTestId("request").textContent).toBe("none");
});
