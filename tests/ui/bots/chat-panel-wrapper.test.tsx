// @vitest-environment jsdom
import React, { useContext } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BotChatPanel } from "../../../packages/ui/src/chat-agents/bots/BotChatPanel.js";
import { BotMessageStateContext } from "../../../packages/ui/src/chat-agents/bots/BotMessageBody.js";
import type { ChatAgentClient } from "../../../packages/ui/src/chat-agents/client.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";

afterEach(cleanup);

function Conversation() {
  const state = useContext(BotMessageStateContext);
  return <section aria-label="Conversation">Transcript and composer
    <textarea aria-label="Conversation draft" defaultValue="" />
    <output aria-label="Inline Bot controls">{state ? state.agentId : "none"}</output>
  </section>;
}

it("retains ordinary Chat transcript and composer without a Bot client", () => {
  render(<BotChatPanel chatId="chat_ordinary"><Conversation /></BotChatPanel>);
  expect(screen.getByRole("region", { name: "Conversation" })).toBeTruthy();
  expect(screen.getByLabelText("Inline Bot controls").textContent).toBe("none");
  expect(screen.queryByRole("region", { name: "Bot controls" })).toBeNull();
});

it("retains ordinary Chat children after the authenticated binding lookup returns no Bot", async () => {
  const base = clientFixture();
  const directBot = vi.fn(async () => null);
  const client = { ...base, bots: { directBot } } as unknown as ChatAgentClient;
  render(<BotChatPanel chatId="chat_ordinary" client={client}><Conversation /></BotChatPanel>);
  await waitFor(() => expect(directBot).toHaveBeenCalledWith("chat_ordinary"));
  expect(screen.getByRole("region", { name: "Conversation" })).toBeTruthy();
  expect(screen.getByLabelText("Inline Bot controls").textContent).toBe("none");
});

it("hides Bot chrome and inline actions without discarding conversation children, then restores them", async () => {
  const base = clientFixture();
  base.list.mockResolvedValue({ enabled: true, agents: [saved] });
  const client = { ...base, bots: { directBot: vi.fn(async () => saved.id) } } as unknown as ChatAgentClient;
  const panel = (visible: boolean) => <BotChatPanel visible={visible} chatId="chat_bot" client={client} directBotId={saved.id}>
    <Conversation />
  </BotChatPanel>;
  const { rerender } = render(panel(true));
  await screen.findByText(saved.name);
  expect(screen.getByLabelText("Inline Bot controls").textContent).toBe(saved.id);
  fireEvent.change(screen.getByRole("textbox", { name: "Conversation draft" }), { target: { value: "Unsent draft" } });
  rerender(panel(false));
  expect(screen.getByRole("region", { name: "Conversation" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Bot controls" })).toBeNull();
  expect(screen.getByLabelText("Inline Bot controls").textContent).toBe("none");
  expect(screen.getByRole("textbox", { name: "Conversation draft" })).toHaveProperty("value", "Unsent draft");
  rerender(panel(true));
  expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
  expect(screen.getByLabelText("Inline Bot controls").textContent).toBe(saved.id);
  expect(screen.getByRole("textbox", { name: "Conversation draft" })).toHaveProperty("value", "Unsent draft");
});
