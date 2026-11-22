// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ChatAppsPanel } from "../../../packages/ui/src/messaging/ChatAppsPanel";
import type { MessagingBridgeSubscribe } from "../../../packages/ui/src/messaging/use-bridge-changes";
import { conversation, conversations, deferred, fakeGateway, messages, readyNoAccounts, readyWithAccounts, status } from "./fixtures";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const STATUS = "GET /api/messages/bridge/status";
const CONVERSATIONS = "GET /api/messages/bridge/conversations";

function socket() {
  const listeners = new Set<(frame: unknown) => void>();
  const subscribe: MessagingBridgeSubscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return { subscribe, emit: (frame: unknown) => act(() => { for (const l of listeners) l(frame); }), listeners };
}

describe("chat apps panel", () => {
  it("shows Not available yet with no link action for owners outside early access", async () => {
    const gateway = fakeGateway({ [STATUS]: () => ({ body: status({ availability: "not_enabled", networks: [] }) }) });
    render(<ChatAppsPanel scope="owner" fetch={gateway.fetch} />);
    expect(await screen.findByText("Not available yet")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Your chat apps" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /connect/i })).toBeNull();
  });

  it("offers retry when the bridge is unavailable", async () => {
    let calls = 0;
    const gateway = fakeGateway({
      [STATUS]: () => {
        calls += 1;
        return { body: calls === 1 ? status({ availability: "unavailable", networks: [] }) : readyNoAccounts() };
      },
      [CONVERSATIONS]: () => ({ body: conversations([]) }),
    });
    render(<ChatAppsPanel scope="owner" fetch={gateway.fetch} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Connect WhatsApp" })).toBeTruthy();
    expect(await screen.findByText("No conversations yet")).toBeTruthy();
  });

  it("lists each network with its accounts and opens the link dialog from Connect", async () => {
    const gateway = fakeGateway({ [STATUS]: () => ({ body: readyWithAccounts() }), [CONVERSATIONS]: () => ({ body: conversations([]) }) });
    render(<ChatAppsPanel scope="owner" fetch={gateway.fetch} />);
    const whatsapp = await screen.findByRole("listitem", { name: "WhatsApp" });
    expect(within(whatsapp).getByText("+46 70 000 0000")).toBeTruthy();
    expect(within(whatsapp).getByText("Connected")).toBeTruthy();
    expect(within(screen.getByRole("listitem", { name: "Telegram" })).getByRole("button", { name: "Reconnect Telegram" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect LinkedIn" }));
    expect(screen.getByRole("dialog", { name: "Connect LinkedIn" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toMatch(/unofficial/);
  });

  it("keeps the row and shows an error when removal fails", async () => {
    const gateway = fakeGateway({
      [STATUS]: () => ({ body: readyWithAccounts() }),
      [CONVERSATIONS]: () => ({ body: conversations([]) }),
      "DELETE /api/messages/bridge/whatsapp/accounts/wa-1": () => ({ status: 503, body: { error: { code: "bridge_unavailable", message: "x" } } }),
    });
    render(<ChatAppsPanel scope="owner" fetch={gateway.fetch} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove +46 70 000 0000" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    expect((await within(screen.getByRole("dialog")).findByRole("alert")).textContent).toBe("Chat apps are unavailable right now. Try again soon.");
    expect(within(screen.getByRole("listitem", { name: "WhatsApp" })).getByText("+46 70 000 0000")).toBeTruthy();
  });

  it("removes the row only after the server confirms", async () => {
    const removal = deferred<{ body: unknown }>();
    let afterRemove = false;
    const gateway = fakeGateway({
      [STATUS]: () => ({ body: afterRemove ? status({ ...readyWithAccounts(), networks: readyWithAccounts().networks.map((n) => (n.network === "whatsapp" ? { ...n, accounts: [] } : n)) }) : readyWithAccounts() }),
      [CONVERSATIONS]: () => ({ body: conversations([]) }),
      "DELETE /api/messages/bridge/whatsapp/accounts/wa-1": () => removal.promise,
    });
    render(<ChatAppsPanel scope="owner" fetch={gateway.fetch} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove +46 70 000 0000" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("button", { name: "Removing…" })).toBeTruthy();
    expect(within(screen.getByRole("listitem", { name: "WhatsApp" })).getByText("+46 70 000 0000")).toBeTruthy();
    afterRemove = true;
    await act(async () => removal.resolve({ body: { ok: true } }));
    await waitFor(() => expect(within(screen.getByRole("listitem", { name: "WhatsApp" })).queryByText("+46 70 000 0000")).toBeNull());
    expect(screen.getByRole("button", { name: "Connect WhatsApp" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refetches status on an accounts change event and ignores malformed frames", async () => {
    let calls = 0;
    const gateway = fakeGateway({
      [STATUS]: () => {
        calls += 1;
        return { body: calls === 1 ? readyNoAccounts() : readyWithAccounts() };
      },
      [CONVERSATIONS]: () => ({ body: conversations([]) }),
    });
    const ws = socket();
    render(<ChatAppsPanel scope="owner" fetch={gateway.fetch} subscribe={ws.subscribe} />);
    await screen.findByRole("button", { name: "Connect WhatsApp" });
    ws.emit({ type: "messages:changed", scope: "accounts", updatedAt: "not-a-date" });
    ws.emit({ type: "os-view:changed", revision: 2, updatedAt: "2026-11-22T10:00:00.000Z" });
    expect(calls).toBe(1);
    ws.emit({ type: "messages:changed", scope: "accounts", updatedAt: "2026-11-22T10:00:00.000Z" });
    expect(await screen.findByText("+46 70 000 0000")).toBeTruthy();
    expect(calls).toBe(2);
  });

  it("polls every 10 s while visible when no owner socket is available", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const gateway = fakeGateway({
      [STATUS]: () => {
        calls += 1;
        return { body: readyNoAccounts() };
      },
    });
    render(<ChatAppsPanel scope="owner" fetch={gateway.fetch} subscribe={() => null} />);
    await screen.findByRole("button", { name: "Connect WhatsApp" });
    expect(calls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(calls).toBe(2);
  });

  it("keeps saved conversations readable with no linked account and while the bridge is unavailable", async () => {
    for (const current of [readyNoAccounts(), status({ availability: "unavailable", networks: [] })]) {
      const gateway = fakeGateway({
        [STATUS]: () => ({ body: current }),
        [CONVERSATIONS]: () => ({ body: conversations([conversation({ roomId: "!saved:bridge.example", displayName: "Saved chat" })]) }),
      });
      const view = render(<ChatAppsPanel scope="owner" fetch={gateway.fetch} />);
      expect(await screen.findByText("Saved chat")).toBeTruthy();
      view.unmount();
    }
  });

  it("polls while the owner socket is down and refreshes once when it reconnects", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let statusCalls = 0;
    let listCalls = 0;
    const gateway = fakeGateway({
      [STATUS]: () => {
        statusCalls += 1;
        return { body: readyWithAccounts() };
      },
      [CONVERSATIONS]: () => {
        listCalls += 1;
        return { body: conversations([]) };
      },
    });
    const ws = socket();
    const view = render(<ChatAppsPanel scope="owner" fetch={gateway.fetch} subscribe={ws.subscribe} connected={false} />);
    await screen.findByText("+46 70 000 0000");
    await waitFor(() => expect(listCalls).toBe(1));
    expect(ws.listeners.size).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(statusCalls).toBe(2);
    expect(listCalls).toBe(2);

    view.rerender(<ChatAppsPanel scope="owner" fetch={gateway.fetch} subscribe={ws.subscribe} connected />);
    await waitFor(() => expect(statusCalls).toBe(3));
    await waitFor(() => expect(listCalls).toBe(3));
    expect(ws.listeners.size).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(statusCalls).toBe(3);
    expect(listCalls).toBe(3);
  });

  it("keeps the open conversation and its draft when the bridge goes down and comes back", async () => {
    let current = readyWithAccounts();
    const room = "!saved:bridge.example";
    const gateway = fakeGateway({
      [STATUS]: () => ({ body: current }),
      [CONVERSATIONS]: () => ({ body: conversations([conversation({ roomId: room, displayName: "Saved chat" })]) }),
      [`GET ${CONVERSATIONS.slice(4)}/${encodeURIComponent(room)}/messages`]: () => ({ body: messages([]) }),
    });
    const ws = socket();
    render(<ChatAppsPanel scope="owner" fetch={gateway.fetch} subscribe={ws.subscribe} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Saved chat/ }));
    const composer = (await screen.findByLabelText("Message Saved chat")) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "half-written reply" } });

    current = status({ availability: "unavailable", networks: [] });
    ws.emit({ type: "messages:changed", scope: "accounts", updatedAt: "2026-11-22T10:00:00.000Z" });
    expect(await screen.findByText(/Chat apps are unavailable right now/)).toBeTruthy();
    expect((screen.getByLabelText("Message Saved chat") as HTMLTextAreaElement).value).toBe("half-written reply");

    current = readyWithAccounts();
    ws.emit({ type: "messages:changed", scope: "accounts", updatedAt: "2026-11-22T10:01:00.000Z" });
    await waitFor(() => expect(screen.queryByText(/Chat apps are unavailable right now/)).toBeNull());
    expect((screen.getByLabelText("Message Saved chat") as HTMLTextAreaElement).value).toBe("half-written reply");
  });

  it("refreshes once after a reconnect the surface reports only through its connection epoch", async () => {
    let statusCalls = 0;
    let listCalls = 0;
    const gateway = fakeGateway({
      [STATUS]: () => {
        statusCalls += 1;
        return { body: readyWithAccounts() };
      },
      [CONVERSATIONS]: () => {
        listCalls += 1;
        return { body: conversations([]) };
      },
    });
    const ws = socket();
    // A short reconnect inside the surface's grace window never reports `connected={false}`.
    const view = render(<ChatAppsPanel scope="owner" fetch={gateway.fetch} subscribe={ws.subscribe} connected connectionEpoch={1} />);
    await screen.findByText("+46 70 000 0000");
    await waitFor(() => expect(listCalls).toBe(1));
    view.rerender(<ChatAppsPanel scope="owner" fetch={gateway.fetch} subscribe={ws.subscribe} connected connectionEpoch={2} />);
    await waitFor(() => expect(statusCalls).toBe(2));
    await waitFor(() => expect(listCalls).toBe(2));
    view.rerender(<ChatAppsPanel scope="owner" fetch={gateway.fetch} subscribe={ws.subscribe} connected connectionEpoch={2} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(statusCalls).toBe(2);
    expect(listCalls).toBe(2);
  });

  it("asks for a computer connection when the surface has no transport", () => {
    render(<ChatAppsPanel scope="owner" fetch={null} />);
    expect(screen.getByRole("alert").textContent).toBe("Connect to your Matrix computer to manage chat apps.");
  });
});
