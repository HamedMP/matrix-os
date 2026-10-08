import { describe, expect, it } from "vitest";
import { ChatOutboxDelivery, type PendingChatOutboxEvent } from "../../packages/gateway/src/chat/outbox-delivery.js";
import type { ChatOwner, ChatOutboxEvent } from "../../packages/gateway/src/chat/records.js";

const OWNER: ChatOwner = { type: "personal", ownerId: "owner_1" };

function event(id: string): ChatOutboxEvent {
  return {
    id,
    chatId: "chat_1",
    eventType: "turn.accepted",
    revision: 1,
    payload: {},
    createdAt: new Date().toISOString(),
  } as ChatOutboxEvent;
}

function pending(id: string): PendingChatOutboxEvent {
  return { owner: OWNER, event: event(id) };
}

describe("ChatOutboxDelivery multi-sink fan-out", () => {
  it("delivers each committed event to every registered sink", () => {
    const delivery = new ChatOutboxDelivery();
    const first: string[] = [];
    const second: string[] = [];
    delivery.registerSink(({ event }) => first.push(event.id));
    delivery.registerSink(({ event }) => second.push(event.id));

    delivery.flush([pending("evt_1"), pending("evt_2")]);
    expect(first).toEqual(["evt_1", "evt_2"]);
    expect(second).toEqual(["evt_1", "evt_2"]);
  });

  it("isolates sink failures so one consumer cannot starve the others", () => {
    const delivery = new ChatOutboxDelivery();
    const delivered: string[] = [];
    delivery.registerSink(() => {
      throw new Error("consumer exploded");
    });
    delivery.registerSink(({ event }) => delivered.push(event.id));

    delivery.flush([pending("evt_1")]);
    expect(delivered).toEqual(["evt_1"]);
  });

  it("stops delivering to a disposed sink while others continue", () => {
    const delivery = new ChatOutboxDelivery();
    const first: string[] = [];
    const second: string[] = [];
    const handle = delivery.registerSink(({ event }) => first.push(event.id));
    delivery.registerSink(({ event }) => second.push(event.id));

    handle.dispose();
    handle.dispose(); // idempotent
    delivery.flush([pending("evt_1")]);
    expect(first).toEqual([]);
    expect(second).toEqual(["evt_1"]);
  });

  it("caps the registry and rejects sinks after release", () => {
    const delivery = new ChatOutboxDelivery();
    for (let index = 0; index < 8; index += 1) {
      delivery.registerSink(() => undefined);
    }
    expect(() => delivery.registerSink(() => undefined)).toThrow(/limit/i);

    delivery.release();
    expect(() => delivery.registerSink(() => undefined)).toThrow(/unavailable/i);
  });

  it("drops pending delivery silently once released", () => {
    const delivery = new ChatOutboxDelivery();
    const delivered: string[] = [];
    delivery.registerSink(({ event }) => delivered.push(event.id));
    delivery.release();
    delivery.flush([pending("evt_1")]);
    expect(delivered).toEqual([]);
  });
});
