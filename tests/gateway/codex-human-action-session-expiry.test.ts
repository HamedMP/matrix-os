import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { AgentThreadSummarySchema, ApprovalDecisionRequestSchema, UserInputAnswerRequestSchema, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { bindNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
import { createCodexExecutionAdmission } from "../../packages/gateway/src/coding-agents/codex-execution-admission.js";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import type { CodexControlClient } from "../../packages/gateway/src/coding-agents/codex-control-client.js";

const hour = 60 * 60 * 1000;
let cleanupFixture: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanupFixture?.();
});
async function fixture(ref?: "unknown" | "foreignref" | "bindingref") {
  const homePath = await mkdtemp(join(tmpdir(), "codex-human-expiry-"));
  let restoreClock: (() => void) | undefined;
  const close = async () => {
    restoreClock?.();
    restoreClock = undefined;
    await rm(homePath, { recursive: true, force: true });
    cleanupFixture = undefined;
  };
  // Own cleanup before any setup can fail, including creation of the clock spy.
  cleanupFixture = close;
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  restoreClock = () => clock.mockRestore();
  const proof = "synthetic-private-principal";
  let observedProof = proof;
  const row = { id: "codex", driverId: "codex", harness: "codex", displayName: "Codex", accentColor: null, enabled: true,
    selectedAccountId: "native_account", accessSourceId: "owner_openai_profile",
    nativeAccountGeneration: createHash("sha256").update(proof).digest("hex"), nativeAccountConsentRevision: 1,
    route: { kind: "fixed", providerId: "openai", modelId: "openai/gpt-5.6" } };
  await mkdir(join(homePath, "system/ai-providers"), { recursive: true });
  const save = () => writeFile(join(homePath, "system/ai-providers/settings.json"), JSON.stringify({
    schemaVersion: 1, revision: 1, harnesses: [row], accountProfiles: [], gatewayPolicy: null, receipts: [],
  }));
  await save();
  const stopSession = vi.fn(async () => undefined);
  const admissionOptions = { homePath, stopSession, isOwner: (id: string) => id === "owner",
    getSnapshot: async () => ({ revision: 1, access: { mode: "writable" },
      accessSources: [{ id: "owner_openai_profile", providerId: "openai", accountId: "native_account", kind: "provider_account", fundingKind: "owner_account" }],
      accounts: [{ id: "native_account", providerId: "openai", accessSourceId: "owner_openai_profile", authMethod: "terminal", authState: "authenticated" }],
    } as unknown as ProviderSettingsSnapshot),
    readNativeAccount: async () => bindNativeAccountMetadata({ accountLabel: "owner@example.test", authMethod: "terminal",
      checkedAt: new Date(now - 1000).toISOString(), staleAfter: new Date(now + 30000).toISOString() }, async () => true, observedProof),
  };
  const setupAdmission = createCodexExecutionAdmission(admissionOptions);
  const binding = await setupAdmission.start("owner", ref === "unknown" ? undefined : "sess_active");
  await setupAdmission.start("owner", "sess_idle");
  if (ref === "foreignref" || ref === "bindingref") {
    const path = join(homePath, "system/ai-providers/codex-execution-sessions.json");
    const entries = JSON.parse(await readFile(path, "utf8"));
    const active = entries.find((entry: { sessionId: string }) => entry.sessionId === "sess_active");
    if (ref === "foreignref") active.userId = "foreign_owner";
    else active.binding = "b".repeat(64);
    await writeFile(path, JSON.stringify(entries));
  }
  const admission = createCodexExecutionAdmission(admissionOptions);
  const control = { submitApproval: vi.fn(), submitInput: vi.fn(), deferInput: vi.fn() };
  const provider = createWorkspaceCodingAgentProvider({ providerId: "codex", agent: "codex", codexAdmission: admission,
    runtime: { startSession: vi.fn(), stopSession: vi.fn() }, codexControl: control as unknown as CodexControlClient });
  const context = { principal: { userId: "owner", source: "jwt" as const },
    thread: AgentThreadSummarySchema.parse({ id: "thread_active", providerId: "codex", title: "Active", status: "running", attention: "none", createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z" }),
    resumeState: { conversationId: "sess_active", nativeAccountBinding: binding }, now: () => new Date(now), nextEventId: () => "evt_answer" };
  const inputRequestId = `req_codex_${"a".repeat(32)}`;
  const approvalId = `appr_codex_${"b".repeat(32)}`;
  const approvalRequest = ApprovalDecisionRequestSchema.parse({
    decision: "approve", clientRequestId: "req_approval", correlationId: "corr_approval",
  });
  const inputRequest = UserInputAnswerRequestSchema.parse({
    answer: "Proceed", structuredAnswers: { [`question_codex_${"c".repeat(24)}`]: ["Proceed"] },
    clientRequestId: "req_input", correlationId: "corr_input",
  });
  const answer = (action: string) => action === "defer"
    ? provider.deferInput!({ principal: context.principal, thread: context.thread, inputRequestId })
    : action === "approval"
    ? provider.submitApproval!({ ...context, approvalId, request: approvalRequest })
    : provider.submitInput!({ ...context, inputRequestId, request: inputRequest });
  return { admission, context, control, answer, stopSession, advance: (hours: number) => { now += hours * hour; },
    changeAccount: () => { observedProof = "other-private-principal"; },
    revoke: async () => { row.enabled = false; await save(); },
    index: async () => JSON.parse(await readFile(join(homePath, "system/ai-providers/codex-execution-sessions.json"), "utf8")),
    close };
}

it.each(["approval", "input", "defer"])("%s refreshes its bound session while an unrelated idle session expires", async action => {
  const f = await fixture();
  try {
    f.advance(23);
    await f.answer(action);
    f.advance(2);
    await f.admission.validateLaunch("owner", "sess_active");
    expect(f.stopSession).toHaveBeenCalledExactlyOnceWith("sess_idle");
    expect(await f.index()).toEqual([expect.objectContaining({ sessionId: "sess_active", userId: "owner" })]);
    expect(f.control[action === "approval" ? "submitApproval" : action === "input" ? "submitInput" : "deferInput"]).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it.each(["approval", "input"].flatMap(action => ["revoked", "binding", "owner"].map(reason => ({ action, reason }))))(
  "$action does not refresh or forward $reason authority", async ({ action, reason }) => {
    const f = await fixture();
    try {
      const before = await f.index();
      f.advance(23);
      if (reason === "revoked") await f.revoke();
      if (reason === "binding") f.context.resumeState.nativeAccountBinding = "b".repeat(64);
      if (reason === "owner") f.context.principal.userId = "foreign_owner";
      await expect(f.answer(action)).rejects.toThrow("unavailable");
      expect(f.control.submitApproval).not.toHaveBeenCalled();
      expect(f.control.submitInput).not.toHaveBeenCalled();
      expect(await f.index()).toEqual(before);
    } finally { await f.close(); }
  },
);

it.each(["revoked", "owner", "account", "unknown", "expired", "foreignref", "bindingref"] as const)(
  "deferral denies %s authority without forwarding or reviving the session", async reason => {
    const f = await fixture(reason === "unknown" || reason === "foreignref" || reason === "bindingref" ? reason : undefined);
    try {
      const before = await f.index();
      f.advance(reason === "expired" ? 25 : 23);
      if (reason === "revoked") await f.revoke();
      if (reason === "owner") f.context.principal.userId = "foreign_owner";
      if (reason === "account") f.changeAccount();
      await expect(f.answer("defer")).rejects.toThrow("unavailable");
      expect(f.control.deferInput).not.toHaveBeenCalled();
      if (reason === "expired") expect(await f.index()).toEqual([]);
      else expect(await f.index()).toEqual(before);
    } finally { await f.close(); }
  },
);
