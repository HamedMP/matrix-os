import { describe, expect, it } from "vitest";
import {
  EMAIL_TRIAGE_LABELS,
  evaluateEmailTriagePolicy,
} from "../../packages/gateway/src/jev/email-triage-policy.js";

const lowScores = {
  urgent: 0.05,
  needs_reply: 0.05,
  personal_intro: 0.05,
  investment: 0.05,
  recruiting: 0.05,
  newsletter: 0.05,
  cold_outreach: 0.05,
};

describe("email-triage-v1 deterministic policy", () => {
  it("requests full context only for snippet scores that cross a verification trigger", () => {
    expect(evaluateEmailTriagePolicy({ scores: { ...lowScores, urgent: 0.4 }, verified: false, ageDays: 2 }).requiresFullContext).toBe(true);
    expect(evaluateEmailTriagePolicy({ scores: { ...lowScores, needs_reply: 0.7 }, verified: false, ageDays: 2 }).requiresFullContext).toBe(true);
    expect(evaluateEmailTriagePolicy({ scores: { ...lowScores, cold_outreach: 0.75 }, verified: false, ageDays: 2 }).requiresFullContext).toBe(true);
    expect(evaluateEmailTriagePolicy({ scores: lowScores, verified: false, ageDays: 2 }).requiresFullContext).toBe(false);
    expect(evaluateEmailTriagePolicy({ scores: { ...lowScores, urgent: 0.9 }, verified: true, ageDays: 2 }).requiresFullContext).toBe(false);
  });

  it("applies overlapping labels while protecting urgent and reply from newsletter or cold outreach", () => {
    const result = evaluateEmailTriagePolicy({
      scores: {
        ...lowScores,
        urgent: 0.72,
        needs_reply: 0.88,
        personal_intro: 0.91,
        investment: 0.87,
        recruiting: 0.86,
      },
      verified: false,
      ageDays: 7,
    });
    expect(result.labels).toEqual([
      EMAIL_TRIAGE_LABELS.urgent,
      EMAIL_TRIAGE_LABELS.needsReply,
      EMAIL_TRIAGE_LABELS.personalIntro,
      EMAIL_TRIAGE_LABELS.investment,
      EMAIL_TRIAGE_LABELS.recruiting,
    ]);

    const protectedResult = evaluateEmailTriagePolicy({
      scores: { ...lowScores, urgent: 0.95, needs_reply: 0.95, newsletter: 0.86, cold_outreach: 0.86 },
      verified: true,
      ageDays: 4,
    });
    expect(protectedResult.labels).not.toContain(EMAIL_TRIAGE_LABELS.urgent);
    expect(protectedResult.labels).not.toContain(EMAIL_TRIAGE_LABELS.needsReply);
    expect(protectedResult.labels).toContain(EMAIL_TRIAGE_LABELS.newsletter);
    expect(protectedResult.labels).toContain(EMAIL_TRIAGE_LABELS.coldOutreach);
  });

  it("archives only fully verified strict cold outreach and removes only INBOX", () => {
    const eligible = evaluateEmailTriagePolicy({
      scores: {
        ...lowScores,
        cold_outreach: 0.94,
        urgent: 0.2,
        personal_intro: 0.3,
        investment: 0.2,
        recruiting: 0.2,
      },
      verified: true,
      ageDays: 12,
    });
    expect(eligible.archive).toEqual({ removeLabelIds: ["INBOX"] });
    expect(eligible.labels).toContain(EMAIL_TRIAGE_LABELS.coldOutreach);
    expect(eligible.labels).not.toContain(EMAIL_TRIAGE_LABELS.review);

    for (const unsafe of [
      { verified: false },
      { scores: { cold_outreach: 0.919 } },
      { scores: { urgent: 0.201 } },
      { scores: { personal_intro: 0.301 } },
      { scores: { investment: 0.201 } },
      { scores: { recruiting: 0.201 } },
    ]) {
      const result = evaluateEmailTriagePolicy({
        scores: { ...eligible.scores, ...unsafe.scores },
        verified: unsafe.verified ?? true,
        ageDays: 12,
      });
      expect(result.archive).toBeNull();
      expect(result.labels).toContain(EMAIL_TRIAGE_LABELS.review);
    }
  });

  it("routes recent borderline evidence to Review without archiving", () => {
    const urgent = evaluateEmailTriagePolicy({ scores: { ...lowScores, urgent: 0.4 }, verified: true, ageDays: 12 });
    const reply = evaluateEmailTriagePolicy({ scores: { ...lowScores, needs_reply: 0.65 }, verified: true, ageDays: 89 });
    const oldReply = evaluateEmailTriagePolicy({ scores: { ...lowScores, needs_reply: 0.7 }, verified: true, ageDays: 91 });
    expect(urgent.labels).toContain(EMAIL_TRIAGE_LABELS.review);
    expect(reply.labels).toContain(EMAIL_TRIAGE_LABELS.review);
    expect(oldReply.labels).not.toContain(EMAIL_TRIAGE_LABELS.review);
    expect(urgent.archive).toBeNull();
  });

  it("treats invalid or negative message ages as old", () => {
    for (const ageDays of [Number.NaN, -1]) {
      const result = evaluateEmailTriagePolicy({
        scores: { ...lowScores, urgent: 0.9, needs_reply: 0.9 },
        verified: true,
        ageDays,
      });
      expect(result.labels).not.toContain(EMAIL_TRIAGE_LABELS.urgent);
      expect(result.labels).not.toContain(EMAIL_TRIAGE_LABELS.needsReply);
      expect(result.labels).not.toContain(EMAIL_TRIAGE_LABELS.review);
    }
  });
});
