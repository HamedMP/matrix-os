import { expect, it } from "vitest";
import { formatRoutineHuman, routineExitCode } from "../../packages/sync-client/src/cli/routine-output.js";
import type { RoutineCliResult } from "@matrix-os/contracts/routine-cli";
const id = "rt_" + "a".repeat(24), requestId = "de000000-0000-4000-8000-000000000100";
const base: Extract<RoutineCliResult, { kind: "receipt" }> = { kind: "receipt", receipt: { operation: "propose", requestId, disposition: "queued", revision: 1, createdAt: "2026-09-27T12:00:00.000Z" }, current: null, approval: null,
  proposal: { handoff: "pending_approval", revision: 5, approval: null, routine: null } };
it.each(["reserved", "submitting", "canonical_queued", "canonical_accepted", "target_task_claimed"] as const)("handoff %s is admission only, never pending/active", handoff => {
  const text = formatRoutineHuman({ ...base, proposal: { ...base.proposal!, handoff } });
  expect(text).toContain("Queued"); expect(text).not.toContain("Pending human approval"); expect(text).not.toContain(": active");
});
it.each(["pending", "approved", "denied", "expired", "cancelled"] as const)("actual %s approval takes precedence over last handoff pending_approval", approval => {
  const text = formatRoutineHuman({ ...base, proposal: { ...base.proposal!, approval } });
  expect(text).toContain(({ pending: "Pending human approval", approved: "Approved; no standing routine", denied: "Declined", expired: "Approval expired", cancelled: "Approval cancelled" } as const)[approval]);
  if (approval !== "pending") expect(text).not.toContain("Pending human approval");
});
it("actual activated routine and immutable admission remain distinct", () => {
  const text = formatRoutineHuman({ ...base, proposal: { ...base.proposal!, approval: "approved", routine: { routineId: id, status: "active", revision: 1 } } });
  expect(text).toContain(": active"); expect(text).not.toContain("Pending human"); expect(base.receipt.disposition).toBe("queued");
});
it("reports unavailable current linkage after an approved edit without claiming no standing routine", () => {
  const text = formatRoutineHuman({ ...base, proposal: { ...base.proposal!, approval: "approved", routine: null, routineLink: "unavailable" } });
  expect(text).toContain("Approved; current routine link unavailable");
  expect(text).not.toContain("no standing routine");
});
it("terminal labels escape controls/bidi and desired-state commits never assert stopped", () => {
  expect(formatRoutineHuman({ kind: "list", routines: [{ routineId: id, name: "name\u001b[31m\u202efake", status: "active", revision: 1, schedule: { kind: "interval", everyMs: 60000 }, nextFireAt: null, lastFire: null, requiresReview: true }], truncated: false })).toContain("name\\u001b[31m\\u202efake");
  for (const operation of ["pause", "archive"] as const) expect(formatRoutineHuman({ ...base, proposal: undefined, receipt: { ...base.receipt, operation, disposition: "applied", routine: { routineId: id, status: operation === "pause" ? "paused" : "archived", revision: 2 } } })).toContain("Worker/effect stop remains unconfirmed");
});
it("unknown preserves reconciliation UUID and has explicit retryable-transport exit75", () => {
  const result = { kind: "unknown", requestId, disposition: "unknown", reconcile: true } as const;
  expect(formatRoutineHuman(result)).toContain(`routines request ${requestId}`); expect(formatRoutineHuman(result)).toContain("Do not retry the mutation"); expect(routineExitCode(result)).toBe(75);
});
