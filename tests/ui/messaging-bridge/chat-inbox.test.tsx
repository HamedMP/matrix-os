// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createMessagingBridgeClient } from "../../../packages/ui/src/messaging/bridge-client";
import { ChatInbox } from "../../../packages/ui/src/messaging/ChatInbox";
import type { MessagingBridgeSubscribe } from "../../../packages/ui/src/messaging/use-bridge-changes";
import { conversation, conversations, deferred, fakeGateway, message, messages } from "./fixtures";

afterEach(() => cleanup());

const BASE = "/api/messages/bridge/conversations";
const ROOM_A = "!room-a:bridge.example";
const ROOM_B = "!room-b:bridge.example";
const room = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
const ADA = conversation({ roomId: ROOM_A, network: "whatsapp", displayName: "Ada", lastMessagePreview: "See you", unreadCount: 3, lastEventAt: "2026-11-22T10:05:00.000Z" });
const BOB = conversation({ roomId: ROOM_B, network: "telegram", displayName: "Bob", lastEventAt: "2026-11-22T09:00:00.000Z" });

function socket() {
  const listeners = new Set<(frame: unknown) => void>();
  const subscribe: MessagingBridgeSubscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return { subscribe, emit: (frame: unknown) => act(() => { for (const l of listeners) l(frame); }) };
}

function renderInbox(routes: Parameters<typeof fakeGateway>[0], subscribe?: MessagingBridgeSubscribe) {
  const gateway = fakeGateway(routes);
  render(<ChatInbox client={createMessagingBridgeClient(gateway.fetch)} networks={["whatsapp", "telegram", "linkedin"]} subscribe={subscribe ?? (() => () => {})} />);
  return gateway;
}

function bubbles() {
  return Array.from(screen.getByRole("log").querySelectorAll("[data-direction]")).reverse().map((el) => `${el.getAttribute("data-direction")}:${el.querySelector("p")?.textContent}`);
}

describe("chat inbox", () => {
  it("lists conversations with network, preview and unread count, filters by network and pages by cursor", async () => {
    const gateway = renderInbox({
      [`GET ${BASE}`]: (request) => {
        if (request.path.includes("network=telegram")) return { body: conversations([BOB]) };
        if (request.path.includes("cursor=page-2")) return { body: conversations([BOB]) };
        return { body: conversations([ADA], "page-2") };
      },
    });
    const ada = await screen.findByRole("button", { name: "Ada, WhatsApp, 3 unread" });
    expect(within(ada).getByText("See you")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await screen.findByRole("button", { name: "Bob, Telegram" });
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Telegram" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Ada/ })).toBeNull());
    expect(screen.getByRole("button", { name: "Bob, Telegram" })).toBeTruthy();
    expect(gateway.requests.map((r) => r.path)).toEqual([`${BASE}?limit=50`, `${BASE}?cursor=page-2&limit=50`, `${BASE}?network=telegram&limit=50`]);
  });

  it("shows an actionable empty state", async () => {
    renderInbox({ [`GET ${BASE}`]: () => ({ body: conversations([]) }) });
    expect(await screen.findByText("No conversations yet")).toBeTruthy();
  });

  it("shows the thread oldest to newest with direction, and loads older messages", async () => {
    renderInbox({
      [`GET ${BASE}`]: () => ({ body: conversations([ADA]) }),
      [`GET ${room(ROOM_A)}/messages`]: (request) =>
        request.path.includes("cursor=older")
          ? { body: messages([message({ eventId: "$0", body: "first ever", occurredAt: "2026-11-22T08:00:00.000Z" })]) }
          : {
              body: messages(
                [
                  message({ eventId: "$2", body: "See you", direction: "outgoing", senderName: "Me", delivery: "sent", occurredAt: "2026-11-22T10:05:00.000Z" }),
                  message({ eventId: "$1", body: "Lunch?", occurredAt: "2026-11-22T10:00:00.000Z" }),
                ],
                "older",
              ),
            },
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Ada/ }));
    await waitFor(() => expect(bubbles()).toEqual(["incoming:Lunch?", "outgoing:See you"]));
    expect(within(screen.getByRole("log")).getByText("Sent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(bubbles()).toEqual(["incoming:first ever", "incoming:Lunch?", "outgoing:See you"]));
  });

  it("sends optimistically and settles to sent", async () => {
    const reply = deferred<{ body: unknown }>();
    const gateway = renderInbox({
      [`GET ${BASE}`]: () => ({ body: conversations([ADA]) }),
      [`GET ${room(ROOM_A)}/messages`]: () => ({ body: messages([]) }),
      [`POST ${room(ROOM_A)}/send`]: () => reply.promise,
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Ada/ }));
    await screen.findByText("No messages yet");
    const composer = screen.getByLabelText("Message Ada") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "  On my way  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(bubbles()).toEqual(["outgoing:On my way"]);
    expect(within(screen.getByRole("log")).getByText("Sending…")).toBeTruthy();
    expect(composer.value).toBe("");
    const sent = gateway.requests.find((r) => r.method === "POST")!.body as { body: string; clientTxnId: string };
    expect(sent.body).toBe("On my way");
    expect(sent.clientTxnId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await act(async () => reply.resolve({ body: message({ eventId: "$sent", direction: "outgoing", senderName: "Me", body: "On my way", delivery: "sent" }) }));
    await waitFor(() => expect(within(screen.getByRole("log")).getByText("Sent")).toBeTruthy());
    expect(bubbles()).toEqual(["outgoing:On my way"]);
  });

  it("marks a failed send and retries with the same clientTxnId without losing the text", async () => {
    let attempt = 0;
    const gateway = renderInbox({
      [`GET ${BASE}`]: () => ({ body: conversations([ADA]) }),
      [`GET ${room(ROOM_A)}/messages`]: () => ({ body: messages([]) }),
      [`POST ${room(ROOM_A)}/send`]: () => {
        attempt += 1;
        return attempt === 1
          ? { status: 503, body: { error: { code: "bridge_unavailable", message: "x" } } }
          : { body: message({ eventId: "$ok", direction: "outgoing", senderName: "Me", body: "Are you there?", delivery: "sent" }) };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Ada/ }));
    await screen.findByText("No messages yet");
    fireEvent.change(screen.getByLabelText("Message Ada"), { target: { value: "Are you there?" } });
    fireEvent.keyDown(screen.getByLabelText("Message Ada"), { key: "Enter" });
    expect(await within(screen.getByRole("log")).findByText("Failed")).toBeTruthy();
    expect(bubbles()).toEqual(["outgoing:Are you there?"]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(screen.getByRole("log")).getByText("Sent")).toBeTruthy());
    const sends = gateway.requests.filter((r) => r.method === "POST").map((r) => r.body as { body: string; clientTxnId: string });
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
  });

  it("retries a send the server recorded as failed with its original clientTxnId", async () => {
    const gateway = renderInbox({
      [`GET ${BASE}`]: () => ({ body: conversations([ADA]) }),
      [`GET ${room(ROOM_A)}/messages`]: () => ({
        body: messages([message({ clientTxnId: "txn-earlier-01", direction: "outgoing", senderName: "Me", body: "Sent yesterday?", delivery: "failed" })]),
      }),
      [`POST ${room(ROOM_A)}/send`]: () => ({
        body: message({ clientTxnId: "txn-earlier-01", eventId: "$late", direction: "outgoing", senderName: "Me", body: "Sent yesterday?", delivery: "sent" }),
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Ada/ }));
    expect(await within(screen.getByRole("log")).findByText("Failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(screen.getByRole("log")).getByText("Sent")).toBeTruthy());
    expect(bubbles()).toEqual(["outgoing:Sent yesterday?"]);
    expect(gateway.requests.find((r) => r.method === "POST")?.body).toEqual({ body: "Sent yesterday?", clientTxnId: "txn-earlier-01" });
  });

  it("never shows a slow response from the previous conversation in the newly opened one", async () => {
    const slowA = deferred<{ body: unknown }>();
    renderInbox({
      [`GET ${BASE}`]: () => ({ body: conversations([ADA, BOB]) }),
      [`GET ${room(ROOM_A)}/messages`]: () => slowA.promise,
      [`GET ${room(ROOM_B)}/messages`]: () => ({ body: messages([message({ eventId: "$b1", senderName: "Bob", body: "from Bob" })]) }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Ada/ }));
    fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Bob/ }));
    await waitFor(() => expect(bubbles()).toEqual(["incoming:from Bob"]));
    await act(async () => slowA.resolve({ body: messages([message({ eventId: "$a1", body: "from Ada" })]) }));
    expect(bubbles()).toEqual(["incoming:from Bob"]);
    expect(screen.getByRole("log", { name: "Messages with Bob" })).toBeTruthy();
  });

  it("refetches the open thread on a messages:changed event for that room only", async () => {
    let threadReads = 0;
    let listReads = 0;
    const ws = socket();
    renderInbox(
      {
        [`GET ${BASE}`]: () => {
          listReads += 1;
          return { body: conversations([ADA]) };
        },
        [`GET ${room(ROOM_A)}/messages`]: () => {
          threadReads += 1;
          return {
            body: messages(
              threadReads === 1
                ? [message({ eventId: "$1", body: "Lunch?" })]
                : [message({ eventId: "$2", body: "Now?", occurredAt: "2026-11-22T10:10:00.000Z" }), message({ eventId: "$1", body: "Lunch?" })],
            ),
          };
        },
      },
      ws.subscribe,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Ada/ }));
    await waitFor(() => expect(bubbles()).toEqual(["incoming:Lunch?"]));
    ws.emit({ type: "messages:changed", scope: "messages", roomId: ROOM_B, updatedAt: "2026-11-22T10:10:00.000Z" });
    await waitFor(() => expect(listReads).toBe(2));
    expect(threadReads).toBe(1);
    ws.emit({ type: "messages:changed", scope: "messages", roomId: ROOM_A, updatedAt: "2026-11-22T10:10:00.000Z" });
    await waitFor(() => expect(bubbles()).toEqual(["incoming:Lunch?", "incoming:Now?"]));
    expect(threadReads).toBe(2);
  });

  it("shows every conversation after refresh when more arrive than one page holds, even interleaved with loaded ones", async () => {
    // Server-side list with offset cursors of 50, newest first.
    const at = (minutes: number) => new Date(Date.parse("2026-11-22T00:00:00.000Z") + minutes * 60_000).toISOString();
    let server = Array.from({ length: 100 }, (_unused, index) => conversation({ roomId: `!old${index}:x`, displayName: `Old ${index}`, lastEventAt: at(1_000 - index * 2) }));
    const page = (path: string) => {
      const sorted = [...server].sort((a, b) => Date.parse(b.lastEventAt!) - Date.parse(a.lastEventAt!));
      const offset = Number(/cursor=(\d+)/.exec(path)?.[1] ?? 0);
      const items = sorted.slice(offset, offset + 50);
      return { body: conversations(items, offset + 50 < sorted.length ? String(offset + 50) : undefined) };
    };
    const ws = socket();
    renderInbox({ [`GET ${BASE}`]: (request) => page(request.path) }, ws.subscribe);
    await screen.findByRole("button", { name: /^Old 0,/ });
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await screen.findByRole("button", { name: /^Old 99,/ });
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();

    // Linking another app adds 60 conversations: 20 newer than everything, 40 interleaved with the loaded ones.
    server = [
      ...server,
      ...Array.from({ length: 60 }, (_unused, index) => conversation({ roomId: `!new${index}:x`, displayName: `New ${index}`, lastEventAt: index < 20 ? at(2_000 + index) : at(1_001 - (index - 20) * 4) })),
    ];
    ws.emit({ type: "messages:changed", scope: "conversations", updatedAt: "2026-11-22T10:00:00.000Z" });
    await screen.findByRole("button", { name: /^New 0,/ });
    while (screen.queryByRole("button", { name: "Show more" })) {
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Loading…" })).toBeNull());
    }
    const shown = new Set(screen.getAllByRole("button", { name: /^(Old|New) \d+,/ }).map((button) => button.getAttribute("aria-label")!.split(",")[0]));
    expect(shown.size).toBe(160);
  });
});
