import { describe, expect, it, vi } from "vitest";
import {
  createCanonicalChatEventSource,
  type CanonicalChatInvalidation,
} from "../../desktop/src/renderer/src/lib/canonical-chat-client";

describe("Electron Desktop canonical Chat event-source adapter", () => {
  it("uses the shared HTTP stream contract and preserves safe invalidation metadata", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(next) { controller = next; } }), {
      headers: { "content-type": "text/event-stream" },
    });
    const openStream = vi.fn(async () => response);
    const source = createCanonicalChatEventSource({ openStream });
    const invalidations: CanonicalChatInvalidation[] = [];
    source.subscribe((next) => invalidations.push(next));

    await source.start();
    controller.enqueue(new TextEncoder().encode([
      'data: {"type":"chat.stream.attached"}',
      "",
      'id: 14',
      'data: {"type":"chat.event","event":{"cursor":14,"chatId":"chat_electron","revision":21,"eventType":"run.message","createdAt":"2026-09-04T00:00:00.000Z"}}',
      "",
      "",
    ].join("\n")));

    await vi.waitFor(() => expect(source.connectionState()).toBe("open"));
    await vi.waitFor(() => expect(invalidations).toEqual([{
      type: "chat.changed",
      chatId: "chat_electron",
      cursor: 14,
      revision: 21,
      eventType: "run.message",
    }]));
    expect(openStream).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    source.dispose();
  });
});
