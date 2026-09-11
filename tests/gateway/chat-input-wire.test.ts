import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route";
import type { CanonicalChatTransportFrame } from "@matrix-os/contracts";
const activity = { id: "act_input", chatId: "chat_input", runId: "run_input", occurredAt: "2026-09-11T00:00:00.000Z",
  type: "input.requested", requestId: "input_question", title: "Question", questions: [{ questionId: "q", header: "Name", question: "Name?", allowOther: false, secret: false }] };
it.each(["0", "1"])("negotiates question payloads on the real HTTP stream with inputVersion=%s", async version => {
  const app = new Hono();
  registerCanonicalChatEventHttpRoute({ app, getPrincipal: () => ({ userId: "owner_input", source: "jwt" }),
    stream: { open: vi.fn(async ({ sink }) => {
      sink.send({ type: "chat.content", event: { cursor: 1 }, content: { activities: [activity] } } as CanonicalChatTransportFrame);
      return { touch: vi.fn(), onClose: vi.fn() };
    }) },
  });
  const response = await app.request(`/api/chats/events?messageVersion=2&inputVersion=${version}`, { headers: { accept: "text/event-stream", "x-matrix-chat-protocol": "2" } });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  try {
    const frame = new TextDecoder().decode((await reader.read()).value);
    expect(frame.includes('"questions"')).toBe(version === "1");
  } finally { await reader.cancel(); }
});
it("rejects an unsupported input version before opening a stream", async () => {
  const app = new Hono();
  const open = vi.fn();
  registerCanonicalChatEventHttpRoute({ app, getPrincipal: () => ({ userId: "owner_input", source: "jwt" }), stream: { open } });
  expect((await app.request("/api/chats/events?inputVersion=12", { headers: { accept: "text/event-stream" } })).status).toBe(400);
  expect(open).not.toHaveBeenCalled();
});
