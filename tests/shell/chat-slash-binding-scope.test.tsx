// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp.js";
import type { ChatAgentClient } from "@matrix-os/ui";
import { clientFixture, saved } from "../desktop/chat-agents-fixture.js";
import { requestChatSearchShortcut } from "@matrix-os/ui";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat.js";

vi.mock("@clerk/nextjs", async importOriginal => ({
  ...(await importOriginal<typeof import("@clerk/nextjs")>()),
  useOrganization: () => ({ organization: null }),
  useAuth: () => ({ userId: null, sessionId: null }),
}));
vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({
  ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

beforeEach(() => {
  localStorage.clear();
  const catalog = createCanonicalProviderCatalogFixture();
  catalog.instances[0]!.skills = [{ id: "review", displayName: "Review", description: "Review changes", invocation: "/review" }];
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(catalog)));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

it("reveals a collapsed Web Chat sidebar before focusing its Search input", async () => {
  render(<ChatApp messages={[]} busy={false} connected conversations={[]}
    onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} />);
  const search = screen.getByRole("textbox", { name: "Search chats" });
  const sidebar = search.closest("aside")!;
  fireEvent.click(screen.getByRole("button", { name: "Close Chat sidebar" }));
  expect(sidebar.className).toContain("w-0");
  act(() => { expect(requestChatSearchShortcut()).toBe(true); });
  expect(sidebar.className).toContain("w-[260px]");
  expect(document.activeElement).toBe(search);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(["resolve", "reject"] as const)("withholds ordinary-provider Skills while Chat identity is unknown (%s)", async outcome => {
  let resolve!: (value: null) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<null>((yes, no) => { resolve = yes; reject = no; });
  const client = {
    bots: { directBot: vi.fn(() => pending) },
    list: vi.fn(async () => ({ enabled: true, agents: [] })),
    search: vi.fn(async () => ({ enabled: true, resources: [] })),
  } as unknown as ChatAgentClient;
  const submit = vi.fn();
  render(<ChatApp messages={[]} sessionId="chat_scope_unknown" busy={false} connected conversations={[]}
    onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={submit} agentClient={client} />);
  await waitFor(() => expect(screen.getByText(/Using/)).toBeTruthy());
  const input = screen.getByRole("textbox", { name: "Message chat" });
  fireEvent.change(input, { target: { value: "/" } });
  expect(screen.queryByRole("option", { name: /\/review/ })).toBeNull();
  expect(screen.getByRole("listbox", { name: "Skills and commands" })).toBeTruthy();
  await act(async () => { if (outcome === "resolve") resolve(null); else reject(new Error("binding unavailable")); });
  if (outcome === "resolve") {
    expect(await screen.findByRole("option", { name: /\/review/ })).toBeTruthy();
  } else {
    expect(screen.queryByRole("option", { name: /\/review/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Skills and commands are unavailable in this Chat.");
  }
  expect((input as HTMLTextAreaElement).value).toBe("/");
  expect(submit).not.toHaveBeenCalled();
});


it("keeps a visible unfocused Web Chat rail fresh and pauses only when its host is hidden", async () => {
  vi.useFakeTimers();
  const agent = { ...saved, recipeRef: { recipeId: "writer", version: "1" } };
  const client = clientFixture();
  client.list.mockResolvedValue({ enabled: true, agents: [agent] });
  const tasks = vi.fn(async () => [{ taskId: "task_one", agentId: agent.id, chatId: "chat_bot",
    revision: 1, status: "running" as const, updatedAt: "2026-10-07T00:00:00.000Z" }]);
  const agentClient = { ...client, bots: { directChat: vi.fn(async () => "chat_bot"), tasks, interactions: vi.fn(async () => []) } } as unknown as ChatAgentClient;
  const chat = (visible: boolean) => <ChatApp messages={[]} sessionId={undefined} active={false} visible={visible}
    busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()}
    onSubmit={vi.fn()} agentClient={agentClient}/>;
  const { rerender } = render(chat(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole("button", { name: `Chat with ${agent.name}` }).getAttribute("data-agent-rail-state")).toBe("working");
  const reads = tasks.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(tasks.mock.calls.length).toBeGreaterThan(reads);
  rerender(chat(false));
  const hiddenReads = tasks.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(tasks).toHaveBeenCalledTimes(hiddenReads);
  rerender(chat(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(tasks.mock.calls.length).toBeGreaterThan(hiddenReads);
});
