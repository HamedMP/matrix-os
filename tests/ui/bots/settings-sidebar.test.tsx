// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BotChatPanel } from "../../../packages/ui/src/chat-agents/bots/BotChatPanel.js";

const authority = { agentId: "bot_research1", revision: 1, grants: [], connections: [], routines: [
  { routineId: "rt_abcdefgh", summary: "Daily brief", status: "active", nextFireAt: null },
], pendingInteractions: [], memory: { items: [{ itemId: "mem_abcdefgh", kind: "preference", scope: "bot",
  content: "Keep briefs concise", source: { at: "2026-09-28T12:00:00.000Z" }, confirmed: true, revision: 1 }] } };
function client() {
  return { bots: { directBot: vi.fn(async () => "bot_research1"), interactions: vi.fn(async () => []),
    tasks: vi.fn(async () => []), authority: vi.fn(async () => authority), revoke: vi.fn(), memory: vi.fn() },
  list: vi.fn(async () => ({ enabled: true, agents: [{ id: "bot_research1", name: "Research Rabbit" }] })) };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps the conversation and draft mounted while settings open beside it and change sections", async () => {
  const api = client();
  const view = render(<BotChatPanel chatId="chat_research" client={api as never} refreshKey={0}>
    <div data-testid="transcript">Conversation</div><textarea aria-label="Reply" defaultValue="My unfinished reply" />
  </BotChatPanel>);
  const reply = screen.getByRole("textbox", { name: "Reply" });
  const trigger = await screen.findByRole("button", { name: "Bot settings" });
  trigger.focus(); fireEvent.click(trigger);
  const settings = screen.getByRole("complementary", { name: "Bot settings" });
  expect(settings.contains(reply)).toBe(false);
  expect(screen.queryByText("Keep briefs concise")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Memory/ }));
  expect(screen.getByText("Keep briefs concise")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Routines/ }));
  expect(screen.getByText("Daily brief")).toBeTruthy();
  await act(async () => {
    view.rerender(<BotChatPanel chatId="chat_research" client={api as never} refreshKey={1}>
      <div data-testid="transcript">Conversation</div><textarea aria-label="Reply" defaultValue="My unfinished reply" />
    </BotChatPanel>);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByRole("textbox", { name: "Reply" })).toBe(reply);
  expect(screen.getByText("Daily brief")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Memory/ }));
  expect(screen.getByText("Keep briefs concise")).toBeTruthy();
  fireEvent.keyDown(settings, { key: "Escape" });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(screen.getByRole("textbox", { name: "Reply" })).toBe(reply);
  expect((reply as HTMLTextAreaElement).value).toBe("My unfinished reply");
});

it("shows a failed settings read and lets the owner retry", async () => {
  const api = client(); api.bots.authority.mockRejectedValueOnce(new Error("postgres /private/token"));
  render(<BotChatPanel chatId="chat_research" client={api as never} />);
  fireEvent.click(await screen.findByRole("button", { name: "Bot settings" }));
  expect(screen.getByRole("complementary").textContent).not.toMatch(/postgres|token/);
  fireEvent.click(screen.getByRole("button", { name: "Retry settings" }));
  await waitFor(() => expect(api.bots.authority).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("No connections yet")).toBeTruthy();
});

it("turns settings into a focus-contained drawer in a narrow Chat window", async () => {
  let resize!: ResizeObserverCallback;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {} disconnect() {} });
  render(<BotChatPanel chatId="chat_research" client={client() as never}><textarea aria-label="Reply" /></BotChatPanel>);
  await screen.findByRole("button", { name: "Bot settings" });
  act(() => resize([{ contentRect: { width: 540 } } as ResizeObserverEntry], {} as ResizeObserver));
  fireEvent.click(screen.getByRole("button", { name: "Bot settings" }));
  const drawer = screen.getByRole("dialog", { name: "Bot settings" });
  expect(drawer.getAttribute("aria-modal")).toBe("true");
  expect(screen.getByRole("textbox", { name: "Reply", hidden: true }).closest("[inert]")).toBeTruthy();
  const last = screen.getByRole("button", { name: /Routines/ }); last.focus();
  fireEvent.keyDown(drawer, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close bot settings" }));
});

it("closes settings on Chat change and preserves non-bot conversation content", async () => {
  const api = client(); api.bots.directBot.mockResolvedValueOnce("bot_research1").mockResolvedValueOnce(null as never);
  const { rerender } = render(<BotChatPanel chatId="chat_research" client={api as never}>Conversation</BotChatPanel>);
  fireEvent.click(await screen.findByRole("button", { name: "Bot settings" }));
  rerender(<BotChatPanel chatId="chat_general" client={api as never}>Other conversation</BotChatPanel>);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Bot settings" })).toBeNull());
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(screen.getByText("Other conversation")).toBeTruthy();
});

it("keeps a confirmed revocation after failed refresh, close, and reopen", async () => {
  const api = client();
  api.bots.authority.mockResolvedValueOnce({ ...authority,
    grants: [{ grantId: "gr_abcdefgh", service: "gmail", accountLabel: "Work", effects: ["read"], audience: "direct", expiresAt: null }],
    connections: [{ service: "gmail", state: "granted" }],
  } as never).mockRejectedValue(new Error("refresh failed"));
  api.bots.revoke.mockResolvedValue(undefined);
  render(<BotChatPanel chatId="chat_research" client={api as never} />);
  fireEvent.click(await screen.findByRole("button", { name: "Bot settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Revoke Work" }));
  await waitFor(() => expect(api.bots.authority).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Close bot settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Bot settings" }));
  expect(screen.queryByRole("button", { name: "Revoke Work" })).toBeNull();
  expect(screen.getByText("Connected · no access")).toBeTruthy();
});

it("moves focus into the drawer when an open wide inspector becomes narrow", async () => {
  let resize!: ResizeObserverCallback;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {} disconnect() {} });
  render(<BotChatPanel chatId="chat_research" client={client() as never}><textarea aria-label="Reply" /></BotChatPanel>);
  fireEvent.click(await screen.findByRole("button", { name: "Bot settings" }));
  screen.getByRole("textbox", { name: "Reply" }).focus();
  act(() => resize([{ contentRect: { width: 500 } } as ResizeObserverEntry], {} as ResizeObserver));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close bot settings" }));
});
