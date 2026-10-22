import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ generate: vi.fn(async () => ({ text: "profile result" })), launch: vi.fn(async () => ({ env: { HOME: "/owner", ANTHROPIC_API_KEY: undefined } })) }));
vi.mock("@matrix-os/kernel", () => ({ generateAppText: mocks.generate }));
vi.mock("../../packages/gateway/src/kernel-credentials.js", () => ({ buildKernelCredentialLaunch: mocks.launch }));
import { generateClaudeProfileAppText } from "../../packages/gateway/src/app-ai/claude-profile-completion.js";
const route = { harnessId: "harness_claude", accountId: "account_claude", accessSourceId: "owner_claude_profile", modelId: "claude-sonnet-5" };
it("holds exact native profile ownership and verifies account identity before no-tools completion", async () => {
    const release = vi.fn();
    const acquire = vi.fn(async () => release);
    const observe = vi.fn(async () => ({ accountLabel: "owner@example.test", authMethod: "terminal", checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 30000).toISOString() }));
    expect(await generateClaudeProfileAppText({ homePath: "/owner", route, prompt: "notes", accountEmail: "owner@example.test", signal: AbortSignal.timeout(1000), profileGuard: { acquire, run: vi.fn() }, revalidate: async () => true, observeAccount: observe })).toEqual({ text: "profile result" });
    expect(acquire).toHaveBeenCalledWith("claude", { kind: "write", durable: true });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
    expect(mocks.launch).toHaveBeenCalledWith("/owner", expect.any(Object), "owner_claude_profile", undefined, { requestClass: "interactive" });
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ model: route.modelId, prompt: "notes" }));
});
it("does not use another CLI account or fallback credentials", async () => {
    mocks.generate.mockClear();
    const release = vi.fn();
    await expect(generateClaudeProfileAppText({ homePath: "/owner", route, prompt: "notes", accountEmail: "owner@example.test", signal: AbortSignal.timeout(1000), profileGuard: { acquire: async () => release, run: vi.fn() }, revalidate: async () => true, observeAccount: async () => ({ accountLabel: "other@example.test", authMethod: "terminal", checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 30000).toISOString() }) })).rejects.toThrow();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
});
