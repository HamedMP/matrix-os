import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { chatFundingVersionUrl } from "@matrix-os/contracts";
import { projectChatFundingErrors } from "../../packages/gateway/src/chat/funding-error-wire.js";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../packages/gateway/src/chat/routes.js";
import { CanonicalChatOrchestrationError } from "../../packages/gateway/src/chat/orchestrator.js";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route.js";
import type { CanonicalChatTransportFrame } from "@matrix-os/contracts";

const legacyError = z.object({ code: z.enum(["run_failed", "provider_unavailable"]), safeMessage: z.string(), retryable: z.boolean(), recoveryActions: z.array(z.string()).optional() }).strict();
const safeError = { code: "insufficient_credit", safeMessage: "Not enough credit for Chat.", retryable: false, recoveryActions: ["select_provider"] };
const errorActivity = { type: "run.error", error: safeError };

describe("canonical Chat funding wire compatibility", () => {
  it.each(["insufficient_credit", "budget_exceeded", "credit_reserved"])("downgrades %s for old strict error parsers without changing persisted data", (code) => {
    const input = { activities: [{ ...errorActivity, error: { ...safeError, code } }] };
    expect(legacyError.safeParse(input.activities[0]!.error).success).toBe(false);
    const projected = projectChatFundingErrors(input, "0");
    expect(projected.activities[0]!.error.code).toBe("run_failed");
    expect(legacyError.safeParse(projected.activities[0]!.error).success).toBe(true);
    expect(input.activities[0]!.error.code).toBe(code);
    expect(projectChatFundingErrors(input, "1")).toBe(input);
  });
  it("does not rewrite user message parts, tool output, or arbitrary nested JSON", () => {
    const input = { messages: [{ parts: [{ error: safeError }] }], activities: [{ type: "tool.completed", output: { error: safeError } }] };
    expect(projectChatFundingErrors(input, "0")).toEqual(input);
  });
  it.each([false, true])("negotiates preflight error responses without rejecting old readers: %s", async (rich) => {
    const routes = createCanonicalChatRoutes({ getPrincipal: () => ({ userId: "owner", source: "jwt" }),
      service: { admitTurn: async () => { throw new CanonicalChatOrchestrationError(safeError as never, 409); } } as unknown as CanonicalChatRouteService });
    const response = await routes.request(`/api/chats/chat_test/turns${rich ? "?fundingVersion=1" : ""}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientRequestId: "req_1", baseRevision: 0, parts: [{ type: "text", text: "hi" }], selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" }, interactionMode: "default", permissionMode: "supervised" }) });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe(rich ? "insufficient_credit" : "provider_unavailable");
  });
  it.each([false, true])("negotiates SSE run-error content without changing published frame: %s", async (rich) => {
    const app = new Hono();
    const frame = { type: "chat.content", event: { cursor: 1 }, content: { activities: [errorActivity] } } as unknown as CanonicalChatTransportFrame;
    registerCanonicalChatEventHttpRoute({ app, getPrincipal: () => ({ userId: "owner", source: "jwt" }),
      stream: { open: async ({ sink }) => { sink.send(frame); sink.close(); return { onClose: () => undefined, touch: () => undefined }; } },
      setIntervalFn: vi.fn(), clearIntervalFn: vi.fn() });
    const response = await app.request(`/api/chats/events?messageVersion=2&inputVersion=1${rich ? "&fundingVersion=1" : ""}`, { headers: { accept: "text/event-stream", "x-matrix-chat-protocol": "2" } });
    expect(response.status).toBe(200);
    const data = (await response.text()).split("data: ")[1]!.trim();
    expect(JSON.parse(data).content.activities[0].error.code).toBe(rich ? "insufficient_credit" : "run_failed");
    expect((frame as any).content.activities[0].error.code).toBe("insufficient_credit");
  });
  it("opts in without corrupting other query parameters or duplicating the version", () => {
    expect(chatFundingVersionUrl("/api/chats/chat_test?limit=100")).toBe("/api/chats/chat_test?limit=100&fundingVersion=1");
    expect(chatFundingVersionUrl(chatFundingVersionUrl("/api/chats/events"))).toBe("/api/chats/events?fundingVersion=1");
  });
});
