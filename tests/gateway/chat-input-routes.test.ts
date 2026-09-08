import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../packages/gateway/src/chat/routes.js";

describe("chat input submission", () => {
  it("validates bounded structured answers and passes authenticated ownership to the service", async () => {
    const submitInput = vi.fn(async () => ({ requestId: "req_prompt", submission: "accepted" }));
    const app = new Hono().route("/", createCanonicalChatRoutes({
      service: { submitInput } as unknown as CanonicalChatRouteService,
      getPrincipal: () => ({ userId: "owner_1", source: "jwt" }),
    }));
    const body = { clientRequestId: "req_answer", answers: { question_1: ["Allow once"] } };
    const send = (payload: unknown) => app.request("/api/chats/chat_one/runs/run_one/inputs/req_prompt", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    expect((await send(body)).status).toBe(200);
    expect(submitInput).toHaveBeenCalledWith({ type: "personal", ownerId: "owner_1" }, "chat_one", "run_one", "req_prompt", body);
    expect((await send({ ...body, answers: { question_1: ["x".repeat(50_000)] } })).status).toBe(413);
    expect(submitInput).toHaveBeenCalledTimes(1);
    expect((await send({ ...body, answers: {} })).status).toBe(400);
  });
});
