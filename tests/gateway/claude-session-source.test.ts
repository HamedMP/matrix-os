import { describe, expect, it, vi } from "vitest";
import { bindNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
import { resolveClaudeSessionSource } from "../../packages/gateway/src/chat/claude-session-source.js";

const input = { owner: { type: "personal" as const, ownerId: "owner_a" }, chatId: "chat_a", turnId: "cturn_a", runId: "run_a",
  prompt: "hello", parts: [{ type: "text" as const, text: "hello" }], selection: { instanceId: "claude_code_default", model: "haiku", options: [] },
  interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal };
const source = { homePath: "/owner", command: "claude", cwd: "/owner/project", args: ["--settings", "{}", "--permission-mode", "default", "--print"],
  env: { HOME: "/owner", PATH: "/bin", ANTHROPIC_API_KEY: "owner-key" }, input };
function metadata(principal = "owner/org-a", verify = async () => true, authMethod: "api_key" | "terminal" = "terminal") {
  return bindNativeAccountMetadata({ accountLabel: "owner@example.test", authMethod, checkedAt: "2026-11-03T00:00:00Z", staleAfter: "2026-11-03T00:00:30Z" }, verify, principal);
}

describe("Claude retained session source", () => {
  it("binds the explicit owner key without observing unrelated native account state", async () => {
    const readNativeMetadata = vi.fn();
    const result = await resolveClaudeSessionSource({ ...source, readNativeMetadata });
    expect(result.schedulingAllowed).toBe(true);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(readNativeMetadata).not.toHaveBeenCalled();
    expect(result.fingerprint).not.toContain("owner-key");
    expect((await resolveClaudeSessionSource({ ...source, env: { ...source.env, ANTHROPIC_API_KEY: "replacement-key" } })).fingerprint).not.toBe(result.fingerprint);
  });
  it("ignores run-scoped capabilities and resume/config transport bytes while retaining stable scope", async () => {
    const a = await resolveClaudeSessionSource(source);
    const b = await resolveClaudeSessionSource({ ...source, input: { ...input, runId: "run_next", turnId: "cturn_next" },
      env: { ...source.env, MATRIX_AGENT_INTEGRATIONS_TOKEN: "fresh-run-grant", MATRIX_SHARED_BROWSER_TOKEN: "fresh-browser" },
      args: [...source.args, "--resume", "native_session", "--mcp-config", "fresh per-run server config"] });
    expect(b).toEqual(a);
    for (const change of [{ chatId: "chat_other" }, { owner: { type: "personal" as const, ownerId: "owner_other" } },
      { permissionMode: "auto" }, { selection: { ...input.selection, model: "sonnet" } }]) {
      expect((await resolveClaudeSessionSource({ ...source, input: { ...input, ...change } })).fingerprint).not.toBe(a.fingerprint);
    }
    expect((await resolveClaudeSessionSource({ ...source, cwd: "/other" })).fingerprint).not.toBe(a.fingerprint);
    expect((await resolveClaudeSessionSource({ ...source, args: ["--settings", '{"sandbox":{"enabled":false}}'] })).fingerprint).not.toBe(a.fingerprint);
  });
  it("uses a fresh verified native principal, including private organization identity", async () => {
    const verify = vi.fn(async () => true);
    const native = { ...source, env: { HOME: "/owner", PATH: "/bin" }, readNativeMetadata: async () => metadata("owner/org-a", verify) };
    const a = await resolveClaudeSessionSource(native);
    expect(a.schedulingAllowed).toBe(true); expect(verify).toHaveBeenCalledOnce();
    const b = await resolveClaudeSessionSource({ ...native, readNativeMetadata: async () => metadata("owner/org-b") });
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });
  it("keeps ordinary Chat usable but refuses scheduling on unavailable, forged or stale identity", async () => {
    const native = { ...source, env: { HOME: "/owner", PATH: "/bin" } };
    for (const readNativeMetadata of [async () => null, async () => { throw new Error("unavailable"); },
      async () => metadata("owner/org-a", async () => false),
      async () => metadata("owner/org-a", async () => true, "api_key"),
      async () => ({ accountLabel: "owner@example.test", authMethod: "terminal" as const, checkedAt: "now", staleAfter: "later" })]) {
      await expect(resolveClaudeSessionSource({ ...native, readNativeMetadata })).resolves.toMatchObject({ schedulingAllowed: false });
    }
  });
  it("does not borrow default native identity for an overridden native profile directory", async () => {
    const readNativeMetadata = vi.fn(async () => metadata());
    const result = await resolveClaudeSessionSource({ ...source, env: { HOME: "/owner", CLAUDE_CONFIG_DIR: "/foreign/.claude" }, readNativeMetadata });
    expect(result.schedulingAllowed).toBe(false); expect(readNativeMetadata).not.toHaveBeenCalled();
  });
  it("does not authorize retained scheduling for shared, agent or review phases or ambiguous credentials", async () => {
    for (const scoped of [{ ...input, sharedScopeId: "shared_scope" }, { ...input, interactionMode: "review" },
      { ...input, owner: { type: "organization" as const, ownerId: "org_a" } }]) {
      expect((await resolveClaudeSessionSource({ ...source, input: scoped })).schedulingAllowed).toBe(false);
    }
    expect((await resolveClaudeSessionSource({ ...source, env: { ...source.env, ANTHROPIC_AUTH_TOKEN: "ambient" } })).schedulingAllowed).toBe(false);
  });
});
