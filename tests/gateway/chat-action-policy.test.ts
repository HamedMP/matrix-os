import { describe, expect, it, vi } from "vitest";
import { revalidateActionPolicy, revalidateFrozenRunPolicy } from "../../packages/gateway/src/chat/action-policy.js";
import { admissionPolicyForTurn } from "../../packages/gateway/src/chat/voice-session-policy.js";
import type { CanonicalChatProviderAdapter } from "../../packages/gateway/src/chat/provider-adapter.js";
const executionPolicy = { revision: "policy_v1", actionMode: "safe_reads" as const, workspaceScope: "apps", tools: ["matrix_list_apps"], delegation: false };
const input = { chatId: "chat_policy", driverKind: "codex" as const, selection: { instanceId: "codex_default", model: "model" }, permissionMode: "supervised" };
const session = { sessionId: "voice_policy", memoryMode: "ordinary" as const, permissionMode: "supervised", executionPolicy };
function adapter(qualified = executionPolicy): CanonicalChatProviderAdapter { return { driverKind: "codex", stateSchemaVersion: 1, parseState: (s) => s, serializeState: (s) => s, qualifyPolicy: vi.fn(async () => qualified), start: async function* () { yield { type: "run.completed", outcome: "completed" }; } }; }
describe("one frozen execution policy for every canonical entry path", () => {
  it("typed and spoken policy share the exact server inventory; client policy grants nothing", async () => {
    for (const source of ["typed", "voice"] as const) {
      const folded = admissionPolicyForTurn({ permissionMode: "full_access", runPolicy: { source, memoryMode: "ordinary", nativeCheckpointPolicy: "reusable", executionPolicy: { ...executionPolicy, tools: ["shell"] } } }, session);
      expect(folded.runPolicy?.executionPolicy).toEqual(executionPolicy);
      expect(folded.permissionMode).toBe("supervised");
      await expect(revalidateActionPolicy(adapter(), input, folded.runPolicy)).resolves.toBeUndefined();
    }
    const requested = { permissionMode: "supervised", runPolicy: { source: "typed" as const, memoryMode: "ordinary" as const, nativeCheckpointPolicy: "reusable" as const, executionPolicy } };
    expect(admissionPolicyForTurn(requested, undefined).runPolicy?.executionPolicy).toBeUndefined();
  });
  it("queued/claimed/retry/steer dispatch checks reject frozen scope/revision/tool drift", async () => {
    const runPolicy = admissionPolicyForTurn({ permissionMode: input.permissionMode }, session).runPolicy;
    for (const drift of [{ workspaceScope: "apps:other" }, { revision: "policy_v2" }, { tools: ["matrix_apply_app_files"] }, { delegation: true }]) {
      await expect(revalidateFrozenRunPolicy(adapter({ ...executionPolicy, ...drift }), { ...input, runPolicy }, { policyForChat: () => session })).rejects.toThrow();
    }
    await expect(revalidateFrozenRunPolicy(adapter(), input, { policyForChat: () => session })).rejects.toThrow();
  });
  it("unqualified native coding, session-only and simulator flags cannot dispatch voice", async () => {
    const native = adapter(); delete native.qualifyPolicy;
    const policy = { source: "voice" as const, memoryMode: "ordinary" as const, nativeCheckpointPolicy: "reusable" as const, executionPolicy };
    vi.stubEnv("MATRIX_VOICE_SIMULATOR", "1");
    try { await expect(revalidateActionPolicy(native, input, policy)).rejects.toThrow(); } finally { vi.unstubAllEnvs(); }
    await expect(revalidateActionPolicy(adapter(), input, { ...policy, memoryMode: "session_only", nativeCheckpointPolicy: "disposable" })).rejects.toThrow();
    await expect(revalidateActionPolicy(native, input)).resolves.toBeUndefined(); // ordinary typed unchanged
  });
});
