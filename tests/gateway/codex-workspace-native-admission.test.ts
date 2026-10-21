import { markSessionStartClean } from "../../packages/gateway/src/coding-agents/session-start-cleanup-proof.js";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import { CodingAgentProviderResumeStateSchema } from "../../packages/gateway/src/coding-agents/provider-adapter.js";
import type { CodexControlClient } from "../../packages/gateway/src/coding-agents/codex-control-client.js";
import { AgentThreadSummarySchema } from "@matrix-os/contracts";

const thread = AgentThreadSummarySchema.parse({ id: "thread_native", providerId: "codex", title: "Native", status: "running", attention: "none", createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z" });
const principal = { userId: "owner", source: "jwt" as const };
const binding = "a".repeat(64);
function fixture() {
  let revoked = false;
  const admission = { releaseStoppedSession: vi.fn(async () => undefined), releaseFailedStart: vi.fn(async () => undefined), prepareRevocation: vi.fn(async () => async () => undefined), validateLaunch: vi.fn(async () => undefined), start: vi.fn(async () => binding), validate: vi.fn(async () => { if (revoked) throw new Error("Selected Codex account is unavailable"); }) };
  const control = { submitTurn: vi.fn(), steerTurn: vi.fn(), submitApproval: vi.fn(), submitInput: vi.fn() };
  const runtime = { getSession: vi.fn(async () => ({ ok: false as const, status: 404, error: { code: "not_found", message: "Not found" } })), startSession: vi.fn(async () => ({ ok: true as const, status: 201 as const, session: { runtime: { type: "background", status: "running" } } })), stopSession: vi.fn() };
  const events = { healthCheck: vi.fn(), watch: vi.fn(async () => ({})), unwatch: vi.fn(), markStopped: vi.fn() };
  const provider = createWorkspaceCodingAgentProvider({ providerId: "codex", agent: "codex", runtime: runtime as never, codexEvents: events as never, codexControl: control as unknown as CodexControlClient, codexAdmission: admission });
  const base = { principal, thread, now: () => new Date(), nextEventId: () => "evt_native", resumeState: { conversationId: "sess_native", nativeAccountBinding: binding } };
  return { provider, admission, control, runtime, events, base, revoke: () => { revoked = true; } };
}

describe("native admission at the actual Codex command boundary", () => {
  it("does not infer absence from a 404 when the runtime has no reservation seam", async () => {
    const f = fixture(); f.events.watch.mockRejectedValueOnce(new Error("watch failed"));
    await expect(f.provider.startThread({ ...f.base, request: { providerId: "codex", prompt: "Inspect", clientRequestId: "req_watch_fail" } })).rejects.toThrow("watch failed");
    expect(f.runtime.startSession).not.toHaveBeenCalled();
    expect(f.admission.releaseFailedStart).not.toHaveBeenCalled();
  });
  it("passes a settled clean failure to exact registration cleanup", async () => {
    const f = fixture();
    const failure = markSessionStartClean({ ok: false, status: 503, error: { code: "runtime_unavailable", message: "Unavailable" } }, "owner", "sess_native");
    f.runtime.startSession.mockResolvedValueOnce(failure as never);
    await expect(f.provider.startThread({ ...f.base, request: { providerId: "codex", prompt: "Inspect", clientRequestId: "req_fail" } })).rejects.toThrow("start failed");
    expect(f.admission.releaseFailedStart).toHaveBeenCalledWith("owner", "sess_native", binding, failure);
  });
  it("persists the admitted nonsecret binding and rechecks after async watch before spawn", async () => {
    const f = fixture();
    const result = await f.provider.startThread({ ...f.base, request: { providerId: "codex", prompt: "Inspect", clientRequestId: "req_native" } });
    expect(result).toMatchObject({ resumeState: { nativeAccountBinding: binding } });
    expect(CodingAgentProviderResumeStateSchema.parse((result as { resumeState: unknown }).resumeState)).toHaveProperty("nativeAccountBinding", binding);
    expect(f.admission.validate).toHaveBeenCalledWith("owner", binding, "sess_native");
    f.events.watch.mockImplementationOnce(async () => { f.revoke(); return {}; });
    await expect(f.provider.startThread({ ...f.base, request: { providerId: "codex", prompt: "Inspect", clientRequestId: "req_raced" } })).rejects.toThrow("unavailable");
    expect(f.runtime.startSession).toHaveBeenCalledTimes(1);
  });
  it.each(["turn", "steer", "approval", "input"])("blocks %s after native authority changes, without sending to the process", async action => {
    const f = fixture(); f.revoke();
    const operation = action === "turn" ? () => f.provider.resumeTurn!({ ...f.base, signal: new AbortController().signal, turn: { turnId: "turn_native", message: "Continue" } })
      : action === "steer" ? () => f.provider.steerTurn!({ ...f.base, message: "Steer", clientRequestId: "req_steer" })
      : action === "approval" ? () => f.provider.submitApproval!({ ...f.base, approvalId: "approval_native", request: { decision: "approve", clientRequestId: "req_approval" } as never })
      : () => f.provider.submitInput!({ ...f.base, inputRequestId: "input_native", request: { structuredAnswers: [], clientRequestId: "req_input" } as never });
    await expect(operation()).rejects.toThrow("unavailable");
    for (const fn of Object.values(f.control)) expect(fn).not.toHaveBeenCalled();
  });
  it("rechecks after watch and before sending a continuation", async () => {
    const f = fixture(); f.events.watch.mockImplementationOnce(async () => { f.revoke(); return {}; });
    await expect(f.provider.resumeTurn!({ ...f.base, signal: new AbortController().signal, turn: { turnId: "turn_native", message: "Continue" } })).rejects.toThrow("unavailable");
    expect(f.control.submitTurn).not.toHaveBeenCalled();
  });
});

it("releases proved predispatch API-key registration without a subscription binding", async () => {
  const f = fixture();
  f.admission.start.mockResolvedValueOnce(undefined as never);
  f.events.watch.mockRejectedValueOnce(new Error("watch unavailable"));
  const proof = markSessionStartClean({}, "owner", "sess_native");
  const cleanFailure = vi.fn(async () => proof);
  Object.assign(f.runtime, { withSessionStart: async (_owner: string, _id: string, operation: (scope: unknown) => unknown) =>
    operation({ startSession: f.runtime.startSession, cleanFailure }) });
  await expect(f.provider.startThread({ ...f.base, request: { providerId: "codex", prompt: "Inspect", clientRequestId: "req_key_watch" } })).rejects.toThrow("watch unavailable");
  expect(f.runtime.startSession).not.toHaveBeenCalled();
  expect(f.admission.releaseFailedStart).toHaveBeenCalledWith("owner", "sess_native", undefined, proof);
});
