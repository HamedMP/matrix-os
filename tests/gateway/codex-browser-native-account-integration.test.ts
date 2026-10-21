import { expect, it, vi } from "vitest";
import { AgentThreadSummarySchema } from "@matrix-os/contracts";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import { withNativeBrowserExecution } from "../../packages/gateway/src/chat/native-browser-execution-context.js";
import { markSessionStartClean } from "../../packages/gateway/src/coding-agents/session-start-cleanup-proof.js";

function fixture() {
  const calls: string[] = [];
  const binding = "a".repeat(64);
  const admission = {
    start: vi.fn(async () => { calls.push("admit"); return binding; }),
    validate: vi.fn(async () => { calls.push("validate"); }),
    releaseFailedStart: vi.fn(async () => undefined),
  };
  const control = { prepareBrowser: vi.fn(async () => { calls.push("browser"); }) };
  const failureProof = markSessionStartClean({}, "owner", "sess_native");
  const cleanFailure = vi.fn(async () => failureProof);
  const runtime = {
    startSession: vi.fn(async () => {
      calls.push("spawn");
      return { ok: true as const, session: { runtime: { type: "background", status: "running" } } };
    }),
    stopSession: vi.fn(async () => ({ ok: false })),
    withSessionStart: async (_owner: string, _session: string, operation: (scope: unknown) => unknown) =>
      operation({ startSession: runtime.startSession, cleanFailure }),
  };
  const events = {
    watch: vi.fn(async () => { calls.push("watch"); return {}; }),
    unwatch: vi.fn(), markStopped: vi.fn(), healthCheck: vi.fn(),
  };
  const unconfirmed = vi.fn();
  const browser = { isLive: () => true, token: "a".repeat(43),
    attemptId: "123e4567-e89b-42d3-a456-426614174000",
    mcpServer: { env: { MATRIX_SHARED_BROWSER_GATEWAY_PORT: "4000" } } };
  const bootstrap = { signal: new AbortController().signal,
    begin: vi.fn(() => { calls.push("track"); return () => { calls.push("settle"); }; }) };
  const provider = createWorkspaceCodingAgentProvider({ providerId: "codex", agent: "codex",
    runtime: runtime as never, codexEvents: events as never, codexControl: control as never,
    codexAdmission: admission as never });
  const thread = AgentThreadSummarySchema.parse({ id: "thread_native", providerId: "codex",
    title: "Native browser", status: "running", attention: "none",
    createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z" });
  const start = () => withNativeBrowserExecution("owner", browser as never, () => provider.startThread({
    principal: { userId: "owner", source: "jwt" }, thread, now: () => new Date(),
    nextEventId: () => "evt_native", signal: new AbortController().signal,
    request: { providerId: "codex", prompt: "Inspect", clientRequestId: "req_native_browser" },
  }), unconfirmed, bootstrap);
  return { start, admission, runtime, control, events, bootstrap, unconfirmed, calls, binding,
    cleanFailure, failureProof };
}

it("rejects native account admission before starting a browser provider process", async () => {
  const f = fixture();
  f.admission.start.mockRejectedValueOnce(new Error("Native account unavailable"));
  await expect(f.start()).rejects.toThrow("Native account unavailable");
  expect(f.runtime.startSession).not.toHaveBeenCalled();
  expect(f.control.prepareBrowser).not.toHaveBeenCalled();
  expect(f.bootstrap.begin).not.toHaveBeenCalled();
});

it("keeps admitted account binding and tracked browser bootstrap in one successful start", async () => {
  const f = fixture();
  await expect(f.start()).resolves.toMatchObject({ resumeState: { nativeAccountBinding: f.binding } });
  expect(f.calls.indexOf("admit")).toBeLessThan(f.calls.indexOf("watch"));
  expect(f.calls.indexOf("validate")).toBeLessThan(f.calls.indexOf("spawn"));
  expect(f.calls.indexOf("track")).toBeLessThan(f.calls.indexOf("spawn"));
  expect(f.calls).toContain("browser");
  expect(f.calls.at(-1)).toBe("settle");
});

it("retains native ownership when browser bootstrap cleanup remains unconfirmed", async () => {
  const f = fixture();
  f.control.prepareBrowser.mockRejectedValueOnce(new Error("Unknown browser acknowledgement"));
  await expect(f.start()).rejects.toThrow("Unknown browser acknowledgement");
  expect(f.runtime.startSession).toHaveBeenCalledOnce();
  expect(f.runtime.stopSession).toHaveBeenCalledOnce();
  expect(f.unconfirmed).toHaveBeenCalledOnce();
  expect(f.admission.releaseFailedStart).not.toHaveBeenCalled();
  expect(f.events.unwatch).toHaveBeenCalledWith("sess_native");
  expect(f.calls.at(-1)).toBe("settle");
});

it("releases only the manager-proved predispatch failure after native revalidation rejects", async () => {
  const f = fixture();
  f.admission.validate.mockRejectedValueOnce(new Error("Native consent changed"));
  await expect(f.start()).rejects.toThrow("Native consent changed");
  expect(f.events.watch).toHaveBeenCalledOnce();
  expect(f.runtime.startSession).not.toHaveBeenCalled();
  expect(f.control.prepareBrowser).not.toHaveBeenCalled();
  expect(f.bootstrap.begin).not.toHaveBeenCalled();
  expect(f.unconfirmed).not.toHaveBeenCalled();
  expect(f.cleanFailure).toHaveBeenCalledOnce();
  expect(f.admission.releaseFailedStart).toHaveBeenCalledWith("owner", "sess_native", f.binding, f.failureProof);
});
