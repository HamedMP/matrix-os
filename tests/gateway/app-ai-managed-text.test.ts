import { describe, expect, it, vi } from "vitest";
import { generateManagedAppText, APP_AI_MANAGED_MODEL } from "../../packages/gateway/src/app-ai/managed-text.js";
import type { MatrixFundedCredentialProvider } from "../../packages/gateway/src/funded-ai-credential-manager.js";
import type { FundedAdmissionQueue } from "../../packages/gateway/src/funded-ai/admission-queue.js";

const completion = (message: unknown = { role: "assistant", content: "摘要" }, finish_reason = "stop") =>
  Response.json({ choices: [{ message, finish_reason }] });
function fixture(fetchImpl = vi.fn(async () => completion())) {
  const getCredential = vi.fn(async () => ({ token: "fixture-lease", relayBaseUrl: "https://relay.example.test/funded", requestClass: "background" }));
  const provider = { enabled: true, getCredential } as unknown as MatrixFundedCredentialProvider;
  const revalidate = vi.fn(async () => true);
  const options = { prompt: "source evidence", model: APP_AI_MANAGED_MODEL, signal: new AbortController().signal,
    requestClass: "background" as const, provider, fetchImpl, revalidate };
  return { options, getCredential, fetchImpl, revalidate };
}
describe("managed app text generation", () => {
  it("uses an explicit fixed model and gateway lease, with no tools or ambient credentials", async () => {
    const f = fixture();
    expect(await generateManagedAppText(f.options)).toEqual({ text: "摘要" });
    expect(f.getCredential).toHaveBeenCalledWith(expect.objectContaining({ requestClass: "background", signal: expect.any(AbortSignal) }));
    const [url, init] = f.fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://relay.example.test/funded/v1/chat/completions");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer fixture-lease");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-matrix-funded-claim-key")).toMatch(/^app_ai:[a-f0-9-]+$/);
    expect(JSON.parse(String(init.body))).toMatchObject({ model: APP_AI_MANAGED_MODEL, stream: false,
      max_tokens: 4096, reasoning_effort: "low", store: false, tool_choice: "none", messages: [{ role: "system" }, { role: "user", content: "source evidence" }] });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("tools");
  });
  it("rejects a model outside the explicit route and missing funded dependencies before dispatch", async () => {
    const f = fixture();
    await expect(generateManagedAppText({ ...f.options, model: "claude-sonnet-5" })).rejects.toThrow("App AI is unavailable");
    await expect(generateManagedAppText({ ...f.options, provider: undefined })).rejects.toThrow("App AI is unavailable");
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    [{ role: "assistant", content: "", }, "stop"],
    [{ role: "assistant", content: "result", refusal: "refused" }, "stop"],
    [{ role: "assistant", content: "result", tool_calls: [{ id: "tool" }] }, "stop"],
    [{ role: "assistant", content: "result", function_call: { name: "exec" } }, "stop"],
    [{ role: "assistant", content: "partial" }, "length"],
    [{ role: "assistant", content: "x".repeat(64001) }, "stop"],
  ])("rejects invalid, incomplete, refused or tool-bearing output", async (message, reason) => {
    const f = fixture(vi.fn(async () => completion(message, reason)));
    await expect(generateManagedAppText(f.options)).rejects.toThrow("App AI is unavailable");
  });
  it("bounds response bytes and sanitizes network and parsing failures", async () => {
    for (const response of [new Response("private provider path"), new Response("x".repeat(262145))]) {
      const f = fixture(vi.fn(async () => response));
      await expect(generateManagedAppText(f.options)).rejects.toThrow(/^App AI is unavailable$/);
    }
    const f = fixture(vi.fn(async () => { throw new Error("private credential error"); }));
    await expect(generateManagedAppText(f.options)).rejects.toThrow(/^App AI is unavailable$/);
  });
  it("uses shared funded admission and rechecks policy before capacity retries", async () => {
    const f = fixture(vi.fn().mockResolvedValueOnce(new Response("capacity", { status: 429, headers: { "x-matrix-funded-reason": "capacity" } })).mockResolvedValueOnce(completion()));
    const run = vi.fn(async (_input, attempt) => {
      expect(await attempt()).toEqual({ kind: "busy" });
      const second = await attempt();
      return second.value;
    });
    expect(await generateManagedAppText({ ...f.options, admission: { run } as unknown as FundedAdmissionQueue })).toEqual({ text: "摘要" });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ requestClass: "background", signal: expect.any(AbortSignal) }), expect.any(Function));
    expect(f.revalidate.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
  it("does not retry provider throttles or dispatch after owner policy revocation", async () => {
    const f = fixture(vi.fn(async () => new Response("limited", { status: 429 })));
    const run = vi.fn(async (_input, attempt) => { const result = await attempt(); expect(result.kind).toBe("done"); return result.value; });
    await expect(generateManagedAppText({ ...f.options, admission: { run } as unknown as FundedAdmissionQueue })).rejects.toThrow();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    const revoked = fixture();
    revoked.getCredential.mockImplementationOnce(async () => { revoked.revalidate.mockResolvedValue(false); return { token: "fixture", relayBaseUrl: "https://relay.example.test", requestClass: "background" }; });
    await expect(generateManagedAppText(revoked.options)).rejects.toThrow();
    expect(revoked.fetchImpl).not.toHaveBeenCalled();
  });
  it("cancels a pending response read when its caller aborts", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const f = fixture(vi.fn(async () => new Response(new ReadableStream({ cancel }))));
    const result = generateManagedAppText({ ...f.options, signal: controller.signal });
    await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(result).rejects.toThrow(/^App AI is unavailable$/);
    expect(cancel).toHaveBeenCalled();
  });
  it("retains the app deadline and rejects output when policy is revoked during generation", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const f = fixture(vi.fn(async () => new Response(new ReadableStream())));
      const result = generateManagedAppText(f.options);
      const rejected = expect(result).rejects.toThrow(/^App AI is unavailable$/);
      await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalledTimes(1));
      expect(timeout).toHaveBeenCalledWith(30000);
      deadline.abort(new DOMException("timeout", "TimeoutError"));
      await rejected;
    } finally { timeout.mockRestore(); }
    const revoked = fixture();
    revoked.fetchImpl.mockImplementationOnce(async () => { revoked.revalidate.mockResolvedValue(false); return completion(); });
    await expect(generateManagedAppText(revoked.options)).rejects.toThrow(/^App AI is unavailable$/);
  });
  it("does not publish when cancellation arrives during the final policy check", async () => {
    const controller = new AbortController();
    const f = fixture();
    let checks = 0;
    f.revalidate.mockImplementation(async () => { if (++checks === 3) controller.abort(); return true; });
    await expect(generateManagedAppText({ ...f.options, signal: controller.signal })).rejects.toThrow(/^App AI is unavailable$/);
  });
});
