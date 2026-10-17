import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createBrowserApprovalControl } from "../../packages/gateway/src/chat/browser-approval-control.js";
import type { SharedBrowserBinding } from "../../packages/gateway/src/shared-browser/broker.js";

const binding: SharedBrowserBinding = { ownerId: "owner", chatId: "chat", runId: "run", harness: "codex" };
const controls: ReturnType<typeof createBrowserApprovalControl>[] = [];
afterEach(async () => { await Promise.all(controls.splice(0).map(control => control.close())); });
function setup() {
  const authority = { reserve: vi.fn(async () => {}), activeGrant: vi.fn(async () => null),
    consumeGrant: vi.fn(async () => {}), consume: vi.fn(async () => {}), invalidateLease: vi.fn(async () => {}), cancelChallenge: vi.fn(async () => {}),
    decide: vi.fn(async (_tuple, proof) => { if (proof !== "owner-proof") throw new Error("Invalid owner proof"); return { alreadySubmitted: false, grant: undefined }; }),
    revoke: vi.fn(async () => { throw new Error("Not configured"); }),
  };
  const control = createBrowserApprovalControl({ authority: authority as never, handle: "pv-test", runtimeSlot: "pv-test", ownerId: "owner" });
  controls.push(control);
  const events: Array<Record<string, unknown>> = [];
  const controller = new AbortController();
  const publish = vi.fn(async event => { events.push(event); });
  const registration = control.registerRun({ binding, signal: controller.signal, publish });
  return { control, authority, events, controller, registration, publish };
}
function decision(s: ReturnType<typeof setup>, choice: "allow_once" | "allow_in_chat" | "not_now" = "allow_once") {
  const event = s.events.find(event => event.type === "approval.requested")!;
  const lifecycle = event.browserApproval as { kind: "shared_chrome"; leaseEpoch: string; challengeRevision: number; scopeVersion: 1 };
  return { ownerId: "owner", chatId: "chat", runId: "run", approvalId: event.approvalId as string,
    input: { clientRequestId: "req_browser", decision: choice === "not_now" ? "decline" as const : "approve" as const,
      actionDigest: event.actionDigest as string, browserApproval: { kind: lifecycle.kind, leaseEpoch: lifecycle.leaseEpoch, challengeRevision: lifecycle.challengeRevision, scopeVersion: lifecycle.scopeVersion, decision: choice } }, proof: "owner-proof" };
}
it("holds exact browser actions until an online-verified owner decision is consumed", async () => {
  const s = setup(); let released = false;
  const pending = s.control.authorizeAction({ binding, action: { action: "tab_new", url: "https://example.com" }, signal: s.controller.signal }).then(() => { released = true; });
  await vi.waitFor(() => expect(s.events).toHaveLength(1)); expect(released).toBe(false);
  const input = decision(s);
  await expect(s.control.submit({ ...input, proof: "machine-only" })).rejects.toThrow(); expect(released).toBe(false);
  expect(s.authority.consume).not.toHaveBeenCalled();
  await s.control.submit(input); await pending;
  expect(s.authority.consume).toHaveBeenCalledOnce(); expect(released).toBe(true);
  expect(s.events[1]).toMatchObject({ type: "approval.resolved", browserApproval: { resolution: "allowed_once" } });
  expect(await s.control.submit(input)).toEqual({ alreadySubmitted: true });
  expect(s.authority.consume).toHaveBeenCalledOnce();
});
it("does not retain lease tombstones for ordinary turns that never use Chrome", async () => {
  const s = setup(); await s.registration.close();
  expect(s.authority.invalidateLease).not.toHaveBeenCalled();
});
it("fences a reservation already in flight when its run closes", async () => {
  const s = setup(); let release!: () => void;
  s.authority.reserve.mockImplementationOnce(() => new Promise<void>(yes => { release = yes; }));
  const pending = s.control.authorizeAction({ binding, action: { action: "snapshot" }, signal: s.controller.signal }).catch(error => error);
  await vi.waitFor(() => expect(s.authority.reserve).toHaveBeenCalledOnce());
  await s.registration.close(); release(); await pending;
  expect(s.authority.invalidateLease).toHaveBeenCalledOnce(); expect(s.events).toEqual([]);
});
it("cancels the exact challenge on interruption without revoking the resumable run", async () => {
  const s = setup(); const action = new AbortController();
  const pending = s.control.authorizeAction({ binding, action: { action: "snapshot" }, signal: action.signal }).catch(error => error);
  await vi.waitFor(() => expect(s.events).toHaveLength(1)); action.abort(); await pending;
  expect(s.authority.cancelChallenge).toHaveBeenCalledWith(expect.objectContaining({ approvalId: s.events[0]!.approvalId }));
  expect(s.authority.invalidateLease).not.toHaveBeenCalled();
});
it("rejects foreign owners, changed digests and scopes without consuming approval", async () => {
  const s = setup();
  const pending = s.control.authorizeAction({ binding, action: { action: "snapshot" }, signal: s.controller.signal }).catch(error => error);
  await vi.waitFor(() => expect(s.events).toHaveLength(1)); const request = decision(s);
  for (const changed of [{ ...request, ownerId: "foreign" }, { ...request, chatId: "other" },
    { ...request, input: { ...request.input, actionDigest: "f".repeat(64) } },
    { ...request, input: { ...request.input, browserApproval: { ...request.input.browserApproval, leaseEpoch: randomUUID() } } }]) {
    await expect(s.control.submit(changed as never)).rejects.toThrow();
  }
  expect(s.authority.decide).not.toHaveBeenCalled(); expect(s.authority.consume).not.toHaveBeenCalled();
  s.controller.abort(); await pending;
});
it("Not now resolves the card but never releases the action", async () => {
  const s = setup();
  const pending = s.control.authorizeAction({ binding, action: { action: "snapshot" }, signal: s.controller.signal }).catch(error => error);
  await vi.waitFor(() => expect(s.events).toHaveLength(1));
  await s.control.submit(decision(s, "not_now"));
  expect(await pending).toBeInstanceOf(Error); expect(s.authority.consume).not.toHaveBeenCalled();
  expect(s.events[1]).toMatchObject({ type: "approval.resolved", decision: "decline", browserApproval: { resolution: "declined" } });
});
it("run shutdown revokes its epoch and cancels pending decisions", async () => {
  const s = setup();
  const pending = s.control.authorizeAction({ binding, action: { action: "snapshot" }, signal: s.controller.signal }).catch(error => error);
  await vi.waitFor(() => expect(s.events).toHaveLength(1)); const request = decision(s);
  await s.registration.close(); expect(await pending).toBeInstanceOf(Error);
  expect(s.authority.invalidateLease).toHaveBeenCalledWith("owner", expect.any(String));
  await expect(s.control.submit(request)).rejects.toThrow();
});
it("checks remembered grants against the owner repository for each exact new action", async () => {
  const s = setup(); const grant = { id: randomUUID(), revision: 3 };
  s.authority.activeGrant.mockResolvedValue(grant as never);
  await s.control.authorizeAction({ binding, action: { action: "snapshot" }, signal: s.controller.signal });
  expect(s.authority.consumeGrant).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "owner", chatId: "chat", runId: "run" }), grant.id, 3);
  expect(s.events).toEqual([]); expect(s.authority.decide).not.toHaveBeenCalled();
});

it("fails closed without hanging if resolution persistence fails after consumption", async () => {
  const s = setup(); let settled = false;
  const pending = s.control.authorizeAction({ binding, action: { action: "snapshot" }, signal: s.controller.signal }).catch(error => { settled = true; return error; });
  await vi.waitFor(() => expect(s.events).toHaveLength(1));
  s.publish.mockRejectedValueOnce(new Error("Storage unavailable"));
  await expect(s.control.submit(decision(s))).rejects.toThrow();
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
  expect(await pending).toBeInstanceOf(Error); expect(s.authority.consume).toHaveBeenCalledOnce();
  expect(s.events[1]).toMatchObject({ type: "approval.resolved", decision: "cancel", browserApproval: { resolution: "interrupted" } });
});
it("ends a published approval when consumed authority fails, then accepts a fresh request", async () => {
  const s = setup();
  const pending = s.control.authorizeAction({ binding, action: { action: "snapshot" }, signal: s.controller.signal }).catch(error => error);
  await vi.waitFor(() => expect(s.events).toHaveLength(1));
  s.authority.consume.mockRejectedValueOnce(new Error("Synthetic storage failure"));
  await expect(s.control.submit(decision(s))).rejects.toThrow();
  expect(await pending).toBeInstanceOf(Error);
  expect(s.events[1]).toMatchObject({ type: "approval.resolved", decision: "cancel", browserApproval: { resolution: "interrupted" } });
  const fresh = s.control.authorizeAction({ binding, action: { action: "snapshot" }, signal: s.controller.signal });
  await vi.waitFor(() => expect(s.events).toHaveLength(3));
  const next = decision({ ...s, events: [s.events[2]!] });
  await s.control.submit(next); await fresh;
  expect(s.events[3]).toMatchObject({ type: "approval.resolved", browserApproval: { resolution: "allowed_once" } });
});
it("never releases approval if the run stops during its consumption", async () => {
  const s = setup();
  const pending = s.control.authorizeAction({ binding, action: { action: "snapshot" }, signal: s.controller.signal }).catch(error => error);
  await vi.waitFor(() => expect(s.events).toHaveLength(1));
  s.authority.consume.mockImplementationOnce(async () => { s.controller.abort(); });
  await expect(s.control.submit(decision(s))).rejects.toThrow(); expect(await pending).toBeInstanceOf(Error);
  expect(s.events.some(event => event.type === "approval.resolved" && event.decision === "approve")).toBe(false);
});
