import { expect, it, vi } from "vitest";
import { submitCanonicalApproval } from "../../packages/gateway/src/chat/approval-submission.js";
const owner = { type: "personal", ownerId: "user_owner" } as const;
const id = `rcact_${"a".repeat(32)}`, digest = "d".repeat(64);
it("routes an exact routine decision before generic provider approvals without dropping actionDigest", async () => {
  const generic = vi.fn(), routine = vi.fn(async () => ({ submission: "accepted" as const }));
  const options = { repository: { getPendingApproval: vi.fn(), getAdapterState: vi.fn() },
    active: { owner, chatId: "chat_source", instanceId: "instance", adapter: { driverKind: "codex", submitApproval: generic } },
    routineActions: { submitChat: routine } };
  await submitCanonicalApproval(options as never, owner, "chat_source", "run_source", id,
    { decision: "approve", clientRequestId: "req_de000000000040008000000000000001", actionDigest: digest }, { routineActionProof: "exact-proof" } as never);
  expect(routine).toHaveBeenCalledWith(owner.ownerId, "chat_source", "run_source", id,
    { decision: "approve", clientRequestId: "req_de000000000040008000000000000001", actionDigest: digest }, "exact-proof");
  expect(generic).not.toHaveBeenCalled(); expect(options.repository.getAdapterState).not.toHaveBeenCalled();
});
it("never falls back to a native provider for an unavailable routine decision", async () => {
  const generic = vi.fn();
  await expect(submitCanonicalApproval({ repository: {} as never, active: { owner, chatId: "chat_source", instanceId: "instance",
    adapter: { submitApproval: generic } as never } }, owner, "chat_source", "run_source", id,
    { decision: "approve", clientRequestId: "req_de000000000040008000000000000001", actionDigest: digest })).rejects.toBeDefined();
  expect(generic).not.toHaveBeenCalled();
});
