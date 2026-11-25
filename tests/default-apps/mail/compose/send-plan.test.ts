import { describe, expect, it } from "vitest";
import { isExplicitSend, planSend, unresolvedWarning, type SendPlanInput } from "../../../../home/apps/mail/src/compose/send-plan";

const base: SendPlanInput = { pendingChanges: 0, invalidRecipients: 0, recipientCount: 1, issues: [], sending: false, attaching: false };

describe("planSend", () => {
  it("sends a clean draft", () => {
    expect(planSend(base)).toEqual({ kind: "send" });
  });

  it("asks for review when tracked changes are unresolved, with their count", () => {
    expect(planSend({ ...base, pendingChanges: 3 })).toEqual({ kind: "review", pending: 3 });
  });

  it("blocks before any warning when recipients are missing or not valid", () => {
    expect(planSend({ ...base, recipientCount: 0, pendingChanges: 2 })).toEqual({ kind: "blocked", reason: "no_recipients" });
    expect(planSend({ ...base, invalidRecipients: 1 })).toEqual({ kind: "blocked", reason: "invalid_recipients" });
    expect(planSend({ ...base, issues: ["too_large"] })).toEqual({ kind: "blocked", reason: "issues" });
  });

  it("does nothing while a send or an attachment is in progress", () => {
    expect(planSend({ ...base, sending: true })).toEqual({ kind: "blocked", reason: "busy" });
    expect(planSend({ ...base, attaching: true })).toEqual({ kind: "blocked", reason: "attaching" });
  });
});

describe("unresolvedWarning", () => {
  it("names the count in the owner's words", () => {
    expect(unresolvedWarning(1).description).toContain("1 tracked change");
    expect(unresolvedWarning(4).description).toContain("4 tracked changes");
    expect(unresolvedWarning(4).title).toMatch(/unresolved/i);
  });
});

describe("isExplicitSend", () => {
  it("accepts only an owner click or the Send keyboard shortcut", () => {
    expect(isExplicitSend({ kind: "click" })).toBe(true);
    expect(isExplicitSend({ kind: "shortcut" })).toBe(true);
    expect(isExplicitSend({ kind: "autosave" } as never)).toBe(false);
    expect(isExplicitSend(undefined as never)).toBe(false);
    expect(isExplicitSend(null as never)).toBe(false);
  });
});
