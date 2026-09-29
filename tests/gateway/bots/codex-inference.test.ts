import { describe, expect, it, vi } from "vitest";
import { forwardBotInference } from "../../../packages/gateway/src/bots/broker-inference.js";

const url = "https://chatgpt.com/backend-api/codex/responses";
const request = {
  version: 1, action: "inference.responses", requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1",
  runtimeHandle: `runtime_${"e".repeat(32)}`, executionGeneration: "6", path: "/v1/responses", headers: {},
  body: JSON.stringify({ model: "gpt-5.6-luna", stream: true, max_output_tokens: 8192, store: true,
    input: [{ role: "developer", content: [{ type: "input_text", text: "Write clearly." }] },
      { role: "user", content: [{ type: "input_text", text: "READY" }] }],
    tools: [{ type: "function", name: "artifact_write", parameters: { type: "object" } }] }),
} as const;
const binding = { requestClass: "interactive", accessSourceId: "owner_openai_profile" } as never;
const authorization = { allowed: true, accessSourceId: "owner_openai_profile", allowedModelIds: ["gpt-5.6-luna"], allowedEgressOrigins: [] } as const;

function setup() {
  const fetchImpl = vi.fn(async () => new Response("event: done\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } }));
  const resolveCodexIdentity = vi.fn(async () => ({ url, headers: { authorization: "Bearer owner-subscription", "chatgpt-account-id": "owner-account" } }));
  return { fetchImpl, resolveCodexIdentity, homePath: "/tmp", lifetime: new AbortController().signal };
}

describe("Pi bot Codex subscription inference", () => {
  it("injects owner OAuth only at the broker and preserves tools in Codex-compatible Responses", async () => {
    const deps = setup();
    const result = await forwardBotInference(request, binding, () => authorization as never, deps);
    expect(result.ok).toBe(true);
    const [target, init] = deps.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe(url);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer owner-subscription");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "gpt-5.6-luna", store: false, stream: true, instructions: "Write clearly.", tools: [{ name: "artifact_write" }] });
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.input).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("owner-subscription");
  });
  it("rejects API-key identities instead of silently using paid API access", async () => {
    const deps = setup();
    deps.resolveCodexIdentity.mockResolvedValue({ url: "https://api.openai.com/v1/responses", headers: { authorization: "Bearer key", "chatgpt-account-id": "" } });
    expect(await forwardBotInference(request, binding, () => authorization as never, deps)).toMatchObject({ ok: false, error: "provider_unavailable" });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });
  it("rechecks revoked authority after resolving the owner identity", async () => {
    const deps = setup(); let allowed = true;
    deps.resolveCodexIdentity.mockImplementation(async () => { allowed = false; return { url, headers: { authorization: "Bearer owner-subscription", "chatgpt-account-id": "owner-account" } }; });
    expect(await forwardBotInference(request, binding, () => (allowed ? authorization : { allowed: false }) as never, deps)).toMatchObject({ ok: false, error: "action_denied" });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });
  it("refreshes once after 401, reauthorizes, and never retries an upstream rate limit", async () => {
    const deps = setup();
    deps.fetchImpl.mockResolvedValueOnce(new Response("", { status: 401 }));
    expect((await forwardBotInference(request, binding, () => authorization as never, deps)).ok).toBe(true);
    expect(deps.resolveCodexIdentity.mock.calls.map((call) => (call as unknown[])[1])).toEqual([false, true]);
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
    const busy = setup();
    busy.fetchImpl.mockResolvedValue(new Response("", { status: 429 }));
    expect(await forwardBotInference(request, binding, () => authorization as never, busy)).toMatchObject({ ok: false });
    expect(busy.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
