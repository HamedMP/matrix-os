import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { CanonicalChatRunActivitySchema, type CanonicalChatTransportFrame } from "@matrix-os/contracts";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../packages/gateway/src/chat/routes.js";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route.js";
import { longClaudeQuestion } from "../fixtures/long-claude-question.js";

const stamp = "2026-11-05T00:00:00.000Z";
const activity = { id: "activity_question", chatId: "chat_question", runId: "run_question", occurredAt: stamp,
  type: "input.requested" as const, requestId: "question", title: "Input needed", questions: [{ ...longClaudeQuestion, questionId: "q0", allowOther: true, secret: false }] };
const record = { chat: { id: "chat_question", ownerScope: { type: "personal" as const, ownerId: "owner" }, title: "Question",
  lifecycle: "active" as const, attention: "none" as const, revision: 0, messageCount: 0, createdAt: stamp, updatedAt: stamp } };

it.each([undefined, "0", "1"])("negotiates full or legacy option descriptions on HTTP and SSE: %s", async version => {
  const suffix = version === undefined ? "" : `&questionDescriptionVersion=${version}`;
  const expected = version === "1" ? longClaudeQuestion.options[0].description : longClaudeQuestion.options[0].description.slice(0, 300);
  const detail = { record, messages: [], turns: [], runs: [], activities: [activity] };
  const service = { getDetail: vi.fn(async () => detail) } as unknown as CanonicalChatRouteService;
  const routes = createCanonicalChatRoutes({ service, getPrincipal: () => ({ userId: "owner", source: "jwt" }) });
  const response = await routes.request(`/api/chats/chat_question?inputVersion=1${suffix}`);
  expect(response.status).toBe(200);
  const value = await response.json();
  expect(value.activities[0].questions[0].options[0].description).toBe(expected);
  expect(CanonicalChatRunActivitySchema.safeParse(value.activities[0]).success).toBe(true);
  expect(detail.activities[0].questions[0]!.options[0]!.description).toBe(longClaudeQuestion.options[0].description);

  const app = new Hono();
  registerCanonicalChatEventHttpRoute({ app, getPrincipal: () => ({ userId: "owner", source: "jwt" }),
    stream: { open: async ({ sink }) => {
      sink.send({ type: "chat.content", event: { cursor: 1 }, content: { activities: [activity] } } as CanonicalChatTransportFrame);
      sink.close(); return { touch() {}, onClose() {} };
    } }, setIntervalFn: vi.fn(), clearIntervalFn: vi.fn() });
  const streamed = await app.request(`/api/chats/events?messageVersion=2&inputVersion=1&assistantTextVersion=1${suffix}`, { headers: { accept: "text/event-stream", "x-matrix-chat-protocol": "2" } });
  expect(streamed.status).toBe(200);
  const frame = JSON.parse((await streamed.text()).split("data: ")[1]!.trim());
  expect(frame.content.activities[0].questions[0].options[0].description).toBe(expected);
});

it.each(["2", "1&questionDescriptionVersion=1"])("rejects an unsupported or repeated description capability before side effects: %s", async value => {
  const getDetail = vi.fn(); const open = vi.fn();
  const routes = createCanonicalChatRoutes({ service: { getDetail } as unknown as CanonicalChatRouteService, getPrincipal: () => ({ userId: "owner", source: "jwt" }) });
  expect((await routes.request(`/api/chats/chat_question?questionDescriptionVersion=${value}`)).status).toBe(400);
  expect(getDetail).not.toHaveBeenCalled();
  const app = new Hono();
  registerCanonicalChatEventHttpRoute({ app, getPrincipal: () => ({ userId: "owner", source: "jwt" }), stream: { open } });
  expect((await app.request(`/api/chats/events?questionDescriptionVersion=${value}`, { headers: { accept: "text/event-stream" } })).status).toBe(400);
  expect(open).not.toHaveBeenCalled();
});
