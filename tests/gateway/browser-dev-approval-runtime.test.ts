import { expect, it } from "vitest";
import { createSupervisedBrowserRuntime } from "../../packages/gateway/src/startup/browser-approvals.js";
import { registerBrowserApprovalRun } from "../../packages/gateway/src/chat/browser-approval-registration.js";
import type { CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";

const ownerId = "user_browser";
const machineId = "5b2bbf01-5d48-48a7-bd62-22dd6b39cd06";
const handle = "owner-dev";
const chatId = "chat_browser";
function scope(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ handle, machineId, ownerId, chatId, runtimeSlot: "dev", expiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides });
}
function start(env: NodeJS.ProcessEnv) {
  return createSupervisedBrowserRuntime({ ownerId, clerkOwnerId: ownerId, env: {
    MATRIX_HANDLE: handle, MATRIX_RUNTIME_SLOT: "dev", MATRIX_MACHINE_ID: machineId,
    DATABASE_URL: "postgresql://synthetic.invalid/owner", PLATFORM_INTERNAL_URL: "https://platform.example.com", UPGRADE_TOKEN: "test-machine-token",
    ...env,
  } });
}

it("composes the exact scoped Dev Chat without changing ordinary supervised runs", async () => {
  const runtime = start({ MATRIX_SUPERVISED_BROWSER_DEV_SCOPE: scope() });
  expect(runtime).toBeDefined();
  try {
    const input: CanonicalProviderRunInput = {
      owner: { type: "personal", ownerId }, chatId, runId: "run_browser", turnId: "turn_browser", parts: [], prompt: "Open a page",
      selection: { instanceId: "codex_default", model: "test" }, permissionMode: "supervised", interactionMode: "default", signal: new AbortController().signal,
    };
    expect(registerBrowserApprovalRun(runtime!.control, { ...input, chatId: "chat_other" }, "codex", async () => {})).toBeUndefined();
    expect(registerBrowserApprovalRun(runtime!.control, input, "codex", async () => {})).toBeDefined();
    expect(await runtime!.control.activeGrant(ownerId, chatId)).toBeNull();
    expect(() => runtime!.control.activeGrant(ownerId, "chat_other")).toThrow();
  } finally {
    await runtime?.close();
  }
});

it.each([
  { MATRIX_SUPERVISED_BROWSER_DEV_SCOPE: "" },
  { MATRIX_SUPERVISED_BROWSER_DEV_SCOPE: "{}", MATRIX_SUPERVISED_BROWSER_APPROVALS_ENABLED: "true" },
  { MATRIX_SUPERVISED_BROWSER_DEV_SCOPE: scope(), MATRIX_SUPERVISED_BROWSER_APPROVALS_ENABLED: "true" },
  { MATRIX_SUPERVISED_BROWSER_DEV_SCOPE: scope({ machineId: "5312bbc2-101a-4691-83c2-e5830df49609" }) },
  { MATRIX_SUPERVISED_BROWSER_DEV_SCOPE: scope({ ownerId: "user_other" }) },
  { MATRIX_SUPERVISED_BROWSER_DEV_SCOPE: scope(), MATRIX_RUNTIME_SLOT: "primary" },
  { MATRIX_SUPERVISED_BROWSER_DEV_SCOPE: scope({ expiresAt: new Date(Date.now() - 60_000).toISOString() }) },
])("fails closed without composing a mismatched Dev scope %#", async env => {
  const runtime = start(env);
  try { expect(runtime).toBeUndefined(); }
  finally { await runtime?.close(); }
});
