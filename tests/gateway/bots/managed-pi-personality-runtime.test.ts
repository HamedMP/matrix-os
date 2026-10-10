import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BotRunSpec, CanonicalChatModelSelection, ChatRunContext } from "@matrix-os/contracts";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import { MANAGED_PI_BASE_PROMPT } from "../../../packages/gateway/src/chat/managed-pi-system-prompt.js";
import { resolveManagedPiRoute, type ResolvedBotRoute } from "../../../packages/gateway/src/bots/route-resolver.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import type { CanonicalProviderRunInput } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "pi-soul-runtime-")); await mkdir(join(home, "system")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });
const soul = () => join(home, "system/soul.md");
const defaults: CanonicalChatModelSelection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
const custom: ChatRunContext = { version: 1, requestHash: "a".repeat(64), chats: [],
  agent: { id: "bot_0123456789abcdef", revision: 1, name: "Custom", instructions: "Custom instructions" } };

function fixture(selection = defaults) {
  const snapshot = makeAiProviderSnapshot();
  const funded = resolveManagedPiRoute(snapshot, defaults);
  const resolved: ResolvedBotRoute = selection.instanceId === "matrix_pi_chatgpt_plan" ? {
    ...funded, accessSourceId: "matrix_chatgpt_plan", route: { ...funded.route, api: "openai-responses", modelId: selection.model },
    subscription: { peerId: "peer_1", accountId: "account_1", grantRevision: 1, computerId: "main" },
  } : selection.instanceId === "matrix_pi_anthropic_api" ? {
    ...funded, accessSourceId: "owner_anthropic_key", route: { ...funded.route, api: "anthropic-messages" }, anthropicApi: { connectionRevision: 1, credentialGeneration: "12345678-1234-4123-8123-123456789abc" },
  } : funded;
  const binding: ManagedPiRuntimeBinding = { kind: "managed_chat", ownerId: "user_owner", chatId: "chat_soul", runId: "run_soul",
    runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", workspace: { kind: "chat_workspace" },
    rootFingerprint: "a".repeat(64), ...resolved, capabilities: ["artifact.read"], requestClass: "interactive" };
  const release = vi.fn(async () => undefined);
  const admit = vi.fn(async (input: { ownerId: string }) => { binding.ownerId = input.ownerId; return binding; });
  let spec: BotRunSpec | undefined;
  const runBot = vi.fn(async () => {
    spec = await runtime.runs.loadRunSpec(binding);
    return { ok: true, reply: { runId: binding.runId, status: "completed", toolActions: 0 } };
  });
  const runtime = createManagedPiRuntime({
    admission: { admit, release, toolAuthority: async () => ({ permissionMode: "supervised" }), workspace: async () => "/unused" },
    host: { client: { runBot } } as unknown as ScopeRuntimeHost,
    providers: { getSnapshot: async () => snapshot }, personality: { homePath: home, runtimeOwnerId: "user_owner" },
    chatgptPlan: { resolve: async () => resolved } as never, matrixAnthropic: { resolve: async () => resolved } as never,
    lifetime: new AbortController().signal, forgetRun: () => undefined, cancelInference: () => undefined,
  });
  const input: CanonicalProviderRunInput = { owner: { type: "personal", ownerId: "user_owner" }, chatId: binding.chatId, turnId: "cturn_soul", runId: binding.runId,
    prompt: "Hello", parts: [{ type: "text", text: "Hello" }], selection, interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal };
  const start = async (overrides: Partial<CanonicalProviderRunInput> = {}) => {
    const events = []; for await (const event of runtime.adapter.start({ ...input, ...overrides })) events.push(event);
    return events;
  };
  return { runtime, runBot, release, admit, start, spec: () => spec };
}

it.each([
  defaults,
  { instanceId: "matrix_pi_chatgpt_plan", model: "account-model", options: [{ id: "accountId", value: "account_1" }, { id: "grantRevision", value: "1" }] },
  { instanceId: "matrix_pi_anthropic_api", model: "claude-sonnet-5", options: [{ id: "connectionRevision", value: "1" }, { id: "credentialGeneration", value: "12345678-1234-4123-8123-123456789abc" }] },
])("loads the same owner personality seam for $instanceId", async selection => {
  await writeFile(soul(), "Use the name Juniper.");
  const f = fixture(selection);
  expect((await f.start()).at(-1)).toMatchObject({ outcome: "completed" });
  expect(f.spec()?.systemPrompt).toContain("Use the name Juniper.");
  expect(f.spec()?.capabilities).toEqual(["artifact.read"]);
  expect(f.spec()?.route.modelId).toBe(selection.model);
});

it("does not load the owner's personality for custom Agent turns", async () => {
  await mkdir(soul()); // Would fail before dispatch if read.
  const f = fixture();
  expect((await f.start({ context: custom })).at(-1)).toMatchObject({ outcome: "completed" });
  expect(f.spec()?.systemPrompt).toBe(MANAGED_PI_BASE_PROMPT);
});

it("does not use the configured runtime owner's home for a foreign admitted owner", async () => {
  await mkdir(soul());
  const f = fixture();
  expect((await f.start({ owner: { type: "personal", ownerId: "user_foreign" } })).at(-1)).toMatchObject({ outcome: "completed" });
  expect(f.spec()?.systemPrompt).toBe(MANAGED_PI_BASE_PROMPT);
});

it.each(["oversized", "directory", "symlink", "invalid"])("refuses %s SOUL before dispatch and logs only its category", async kind => {
  if (kind === "oversized") await writeFile(soul(), "PRIVATE_CANARY".repeat(2000));
  if (kind === "directory") await mkdir(soul());
  if (kind === "symlink") { await writeFile(join(home, "private.md"), "PRIVATE_CANARY"); await symlink(join(home, "private.md"), soul()); }
  if (kind === "invalid") await writeFile(soul(), Buffer.from([0xff]));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const f = fixture();
  const events = await f.start();
  expect(events).toEqual([{ type: "run.completed", outcome: "failed", error: {
    code: "run_failed", safeMessage: "Matrix AI could not finish this request. Try again.", retryable: true, recoveryActions: ["retry"],
  } }]);
  expect(f.runBot).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledExactlyOnceWith("[managed-pi] run failed", { stage: "run_spec", error: "personality_unavailable",
    category: kind === "oversized" ? "too_large" : kind === "invalid" ? "invalid_text" : "unsafe_file" });
  expect(JSON.stringify(warn.mock.calls)).not.toContain(home);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_CANARY");
});

it.each([
  { owner: { type: "organization" as const, ownerId: "user_owner" } },
  { sharedScopeId: "shared_1" },
])("rejects nonpersonal/shared turns before admission or filesystem read", async overrides => {
  await mkdir(soul());
  const f = fixture();
  await expect(f.start(overrides)).rejects.toThrow("Unsupported Matrix AI input");
  expect(f.admit).not.toHaveBeenCalled();
  expect(f.runBot).not.toHaveBeenCalled();
});
