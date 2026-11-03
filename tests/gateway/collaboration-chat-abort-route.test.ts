import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerChatRoutes } from "../../packages/gateway/src/collaboration/chat-routes.js";
import type { CollaborationRouteOptions } from "../../packages/gateway/src/collaboration/route-support.js";

describe("shared Chat HTTP cancellation", () => {
  it("propagates HTTP cancellation to shared admission", async () => {
    const scopeId="10000000-0000-4000-8000-000000000001";
    const submit=vi.fn(async()=>({}));
    const routes=new Hono();
    registerChatRoutes(routes, {
      verifier:{verifyAndAuthorize:async()=>({scopeId,capability:"request_ai"})},
      chatExecutionAdapter:{submit},
    } as unknown as CollaborationRouteOptions);
    const controller=new AbortController();
    const request=new Request(`http://localhost/api/collaboration/scopes/${scopeId}/chat/requests`,{
      method:"POST",signal:controller.signal,
      headers:{"content-type":"application/json","x-matrix-collaboration-proof":Buffer.from("{}").toString("base64url")},
      body:JSON.stringify({clientRequestId:"50000000-0000-4000-8000-000000000001",expectedRevision:"0",text:"Question"}),
    });
    expect((await routes.request(request)).status).toBe(201);
    controller.abort();
    expect(submit.mock.calls[0]).toHaveLength(3);
    expect((submit.mock.calls[0] as unknown as [unknown,unknown,AbortSignal])[2].aborted).toBe(true);
  });
});
