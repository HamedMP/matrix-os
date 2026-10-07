// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatAgentListResponse } from "@matrix-os/contracts";
import { ChatAgentsRailSection } from "../../../packages/ui/src/chat-agents/ChatAgentsRailSection.js";
import { ChatAgentsWorkspace } from "../../../packages/ui/src/chat-agents/ChatAgentsNavigation.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const library = { enabled: true, agents: [saved] };
function rail(client: ReturnType<typeof clientFixture>, route = "chat_one") {
  return <ChatAgentsWorkspace><ChatAgentsRailSection key={route} activeChatId={route} client={client} /></ChatAgentsWorkspace>;
}
async function loaded(client: ReturnType<typeof clientFixture>) {
  client.list.mockResolvedValue(library);
  const view = render(rail(client));
  await screen.findByRole("button", { name: `Chat with ${saved.name}` });
  return view;
}

it("keeps the verified Agents section through a real sidebar remount while revalidating", async () => {
  const client = clientFixture(); const { rerender } = await loaded(client);
  let finish!: (value: ChatAgentListResponse) => void;
  client.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  rerender(rail(client, "project_one"));
  expect(screen.getByRole("button", { name: "Agents" })).toBeTruthy();
  expect(screen.getByRole("button", { name: `Chat with ${saved.name}` })).toBeTruthy();
  await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
  await act(async () => finish({ enabled: true, agents: [{ ...saved, name: "Fresh definition" }] }));
  expect(await screen.findByRole("button", { name: "Chat with Fresh definition" })).toBeTruthy();
});

it("retains the verified list after a transient reload failure and retries without disappearing", async () => {
  const client = clientFixture(); const { rerender } = await loaded(client);
  client.list.mockRejectedValueOnce(new Error("private runtime failure"));
  rerender(rail(client, "chat_two"));
  await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole("button", { name: `Chat with ${saved.name}` })).toBeTruthy();
  client.list.mockResolvedValue({ enabled: true, agents: [{ ...saved, name: "Recovered definition" }] });
  fireEvent(window, new Event("focus"));
  expect(await screen.findByRole("button", { name: "Chat with Recovered definition" })).toBeTruthy();
});

it.each([true, false])("accepts an authoritative empty list (enabled=%s) and does not resurrect it on remount", async enabled => {
  const client = clientFixture(); const { rerender } = await loaded(client);
  client.list.mockResolvedValue({ enabled, agents: [] });
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(screen.queryByRole("button", { name: `Chat with ${saved.name}` })).toBeNull());
  client.list.mockImplementationOnce(() => new Promise(() => {}));
  rerender(rail(client, "project_one"));
  expect(screen.queryByRole("button", { name: `Chat with ${saved.name}` })).toBeNull();
  if (enabled) expect(screen.getByRole("button", { name: "Agents" })).toBeTruthy();
  else expect(screen.queryByRole("button", { name: "Agents" })).toBeNull();
});

it("never hydrates a replacement client from an old owner/runtime or its late response", async () => {
  const client = clientFixture(); const { rerender } = await loaded(client);
  let finish!: (value: ChatAgentListResponse) => void;
  client.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent(window, new Event("focus")); await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
  const next = clientFixture(); next.list.mockImplementationOnce(() => new Promise(() => {}));
  rerender(rail(next));
  expect(screen.queryByRole("button", { name: `Chat with ${saved.name}` })).toBeNull();
  await act(async () => finish({ enabled: true, agents: [{ ...saved, name: "Other owner definition" }] }));
  expect(screen.queryByRole("button", { name: "Chat with Other owner definition" })).toBeNull();
});

it("does not fabricate an Agents section during a cold start with no verified library", () => {
  const client = clientFixture(); client.list.mockImplementationOnce(() => new Promise(() => {}));
  render(rail(client));
  expect(screen.queryByRole("button", { name: "Agents" })).toBeNull();
  expect(screen.queryByRole("button", { name: `Chat with ${saved.name}` })).toBeNull();
});

it.each([true, false])("publishes authoritative enabled=%s to both mounted same-client rails even when one is hidden", async enabled => {
  const client = clientFixture();
  client.list.mockResolvedValue(library);
  const { container, rerender } = render(<ChatAgentsWorkspace>
    <div data-rail="a"><ChatAgentsRailSection client={client} visible /></div>
    <div data-rail="b"><ChatAgentsRailSection client={client} visible={false} /></div>
  </ChatAgentsWorkspace>);
  const a = within(container.querySelector('[data-rail="a"]') as HTMLElement);
  const b = within(container.querySelector('[data-rail="b"]') as HTMLElement);
  await a.findByRole("button", { name: `Chat with ${saved.name}` });
  // B becomes active and establishes its own local copy, then A is hidden.
  rerender(<ChatAgentsWorkspace>
    <div data-rail="a"><ChatAgentsRailSection client={client} visible /></div>
    <div data-rail="b"><ChatAgentsRailSection client={client} visible /></div>
  </ChatAgentsWorkspace>);
  await b.findByRole("button", { name: `Chat with ${saved.name}` });
  await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
  rerender(<ChatAgentsWorkspace>
    <div data-rail="a"><ChatAgentsRailSection client={client} visible={false} /></div>
    <div data-rail="b"><ChatAgentsRailSection client={client} visible /></div>
  </ChatAgentsWorkspace>);
  client.list.mockResolvedValue({ enabled, agents: [] });
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(b.queryByRole("button", { name: `Chat with ${saved.name}` })).toBeNull());
  expect(a.queryByRole("button", { name: `Chat with ${saved.name}` })).toBeNull();
  if (!enabled) {
    expect(a.queryByRole("button", { name: "Agents" })).toBeNull();
    expect(b.queryByRole("button", { name: "Agents" })).toBeNull();
  }
});
