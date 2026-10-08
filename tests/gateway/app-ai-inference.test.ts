import { expect, it, vi } from "vitest";
import { generateApiAppText } from "../../packages/gateway/src/app-ai/api-completion.js";
const route = { harnessId: "matrix_ai", accountId: null, accessSourceId: "matrix_cloudflare", modelId: "@cf/zai-org/glm-5.3-flash" };
it("uses the exact funded relay and claim header with no tools or ambient credentials", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
        expect(_url).toBe("https://relay.matrix.test/v1/chat/completions");
        const body = JSON.parse(init.body as string);
        expect(body.model).toBe(route.modelId);
        expect(body.stream).toBe(false);
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBe("none");
        expect(body.store).toBe(false);
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer funded-only");
        expect(new Headers(init.headers).get("x-matrix-funded-claim-key")).toMatch(/^app-/);
        expect(init.redirect).toBe("error");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: "summary" } }] });
    });
    const provider = { enabled: true as const, maxRunMs: 30000, getCredential: vi.fn(async () => ({ token: "funded-only", relayBaseUrl: "https://relay.matrix.test", maxRunMs: 30000 })), invalidate: vi.fn(), close: vi.fn() };
    const revalidate = vi.fn(async () => true);
    expect(await generateApiAppText({ homePath: "/unused", route, prompt: "notes", signal: AbortSignal.timeout(1000), fundedCredentialProvider: provider as never, revalidate, fetchImpl: fetchImpl as typeof fetch })).toEqual({ text: "summary" });
    expect(provider.getCredential).toHaveBeenCalledWith(expect.objectContaining({ requestClass: "interactive", signal: expect.any(AbortSignal) }));
    expect(revalidate).toHaveBeenCalled();
});
it("does not start paid inference after an app grant/route is revoked during leasing", async () => {
    const fetchImpl = vi.fn();
    await expect(generateApiAppText({ homePath: "/unused", route, prompt: "notes", signal: AbortSignal.timeout(1000), fundedCredentialProvider: { enabled: true, getCredential: async () => ({ token: "funded-only", relayBaseUrl: "https://relay.matrix.test" }) } as never, revalidate: async () => false, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
});
it("rejects tool call and truncated API outputs", async () => {
    const provider = { enabled: true, getCredential: async () => ({ token: "funded-only", relayBaseUrl: "https://relay.matrix.test" }) } as never;
    for (const finish_reason of ["tool_calls", "length"]) {
        await expect(generateApiAppText({ homePath: "/unused", route, prompt: "notes", signal: AbortSignal.timeout(1000), fundedCredentialProvider: provider, revalidate: async () => true, fetchImpl: async () => Response.json({ choices: [{ finish_reason, message: { content: "bad", tool_calls: [{}] } }] }) })).rejects.toThrow();
    }
});
it("rejects oversized and late-revoked API replies",async()=>{
    const provider={enabled:true,getCredential:async()=>({token:"funded-only",relayBaseUrl:"https://relay.matrix.test"})} as never;
    await expect(generateApiAppText({homePath:"/unused",route,prompt:"notes",signal:AbortSignal.timeout(1000),fundedCredentialProvider:provider,revalidate:async()=>true,fetchImpl:async()=>new Response("x".repeat(300000))})).rejects.toThrow();
    const revalidate=vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(generateApiAppText({homePath:"/unused",route,prompt:"notes",signal:AbortSignal.timeout(1000),fundedCredentialProvider:provider,revalidate,fetchImpl:async()=>Response.json({choices:[{finish_reason:"stop",message:{content:"ok"}}]})})).rejects.toThrow();
});
