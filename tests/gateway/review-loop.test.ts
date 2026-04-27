import { describe, it, expect } from "vitest";
import {
  approveReview,
  completeImplementation,
  completeReview,
  completeVerification,
  createReviewLoopRecord,
  startNextReviewRound,
  stopReview,
} from "../../packages/gateway/src/review-loop.js";
import type { FindingsParseSuccess, FindingsParseFailure } from "../../packages/gateway/src/findings-parser.js";

const parsedWithFindings: FindingsParseSuccess = {
  ok: true,
  parserStatus: "success",
  findings: [{
    id: "F-001",
    severity: "high",
    file: "packages/gateway/src/auth.ts",
    line: 42,
    summary: "Fix auth",
  }],
  findingsCount: 1,
  severityCounts: { high: 1, medium: 0, low: 0 },
};

const parsedEmpty: FindingsParseSuccess = {
  ok: true,
  parserStatus: "success",
  findings: [],
  findingsCount: 0,
  severityCounts: { high: 0, medium: 0, low: 0 },
};

const parseFailed: FindingsParseFailure = {
  ok: false,
  parserStatus: "failed",
  error: { code: "finding_field_missing", message: "Finding is missing a required field" },
};

describe("review-loop", () => {
  const now = () => "2026-04-26T00:00:00.000Z";

  it("creates a queued review and starts a legal reviewer round", () => {
    const record = createReviewLoopRecord({
      id: "rev_abc123",
      projectSlug: "repo",
      worktreeId: "wt_abc123def456",
      pr: 42,
      reviewer: "claude",
      implementer: "codex",
      maxRounds: 3,
      convergenceGate: "findings_only",
      verificationCommands: [],
      now,
    });

    const started = startNextReviewRound(record, { sessionId: "sess_review_1", now });

    expect(started).toMatchObject({
      ok: true,
      review: {
        status: "reviewing",
        round: 1,
        activeSessionId: "sess_review_1",
        rounds: [{ round: 1, phase: "review", sessionId: "sess_review_1" }],
      },
    });
  });

  it("transitions review findings to implementer and then starts the next reviewer round", () => {
    const started = startNextReviewRound(createReviewLoopRecord(baseInput(now)), { sessionId: "sess_review_1", now });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const needsImplementation = completeReview(started.review, { parseResult: parsedWithFindings, now });
    expect(needsImplementation).toMatchObject({
      ok: true,
      review: {
        status: "implementing",
        round: 1,
        rounds: [expect.objectContaining({ findingsCount: 1, severityCounts: { high: 1, medium: 0, low: 0 } })],
      },
    });
    if (!needsImplementation.ok) return;

    const next = completeImplementation(needsImplementation.review, {
      sessionId: "sess_review_2",
      commit: "abc1234",
      now,
    });

    expect(next).toMatchObject({
      ok: true,
      review: {
        status: "reviewing",
        round: 2,
        activeSessionId: "sess_review_2",
        rounds: [
          expect.objectContaining({ implementerCommit: "abc1234" }),
          expect.objectContaining({ round: 2, phase: "review", sessionId: "sess_review_2" }),
        ],
      },
    });
  });

  it("converges on zero findings and honors verification gates", () => {
    const findingsOnly = startNextReviewRound(createReviewLoopRecord(baseInput(now)), { sessionId: "sess_review_1", now });
    expect(findingsOnly.ok).toBe(true);
    if (!findingsOnly.ok) return;
    expect(completeReview(findingsOnly.review, { parseResult: parsedEmpty, now })).toMatchObject({
      ok: true,
      review: { status: "converged" },
    });

    const gatedRecord = createReviewLoopRecord({
      ...baseInput(now),
      convergenceGate: "findings_and_verify",
      verificationCommands: ["pnpm test"],
    });
    const gatedStarted = startNextReviewRound(gatedRecord, { sessionId: "sess_review_1", now });
    expect(gatedStarted.ok).toBe(true);
    if (!gatedStarted.ok) return;
    const verifying = completeReview(gatedStarted.review, { parseResult: parsedEmpty, now });
    expect(verifying).toMatchObject({ ok: true, review: { status: "verifying" } });
    if (!verifying.ok) return;
    expect(completeVerification(verifying.review, { passed: true, now })).toMatchObject({
      ok: true,
      review: { status: "converged" },
    });
    expect(completeVerification(verifying.review, { passed: false, now })).toMatchObject({
      ok: true,
      review: {
        status: "failed",
        rounds: [expect.anything(), expect.objectContaining({
          error: { code: "verification_failed", message: "Verification failed" },
        })],
      },
    });
  });

  it("records parse failure and stalls at max rounds without ambiguous terminal states", () => {
    const started = startNextReviewRound(createReviewLoopRecord({ ...baseInput(now), maxRounds: 1 }), { sessionId: "sess_review_1", now });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(completeReview(started.review, { parseResult: parseFailed, now })).toMatchObject({
      ok: true,
      review: { status: "failed_parse", rounds: [expect.objectContaining({ parserStatus: "failed" })] },
    });
    expect(completeReview(started.review, { parseResult: parsedWithFindings, now })).toMatchObject({
      ok: true,
      review: { status: "stalled" },
    });
  });

  it("rejects illegal transitions and allows explicit stop or approval from terminal operator states", () => {
    const record = createReviewLoopRecord(baseInput(now));
    const started = startNextReviewRound(record, { sessionId: "sess_review_1", now });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(startNextReviewRound(started.review, { sessionId: "sess_review_2", now })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "illegal_review_transition" },
    });
    expect(approveReview(started.review, { now })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "illegal_review_transition" },
    });
    expect(stopReview(started.review, { now })).toMatchObject({
      ok: true,
      review: { status: "stopped", activeSessionId: undefined },
    });

    const stalled = completeReview(started.review, { parseResult: parsedWithFindings, now });
    if (!stalled.ok) return;
    const forcedStalled = { ...stalled.review, status: "stalled" as const };
    expect(approveReview(forcedStalled, { now })).toMatchObject({
      ok: true,
      review: { status: "approved" },
    });

    const converged = completeReview(started.review, { parseResult: parsedEmpty, now });
    if (!converged.ok) return;
    expect(approveReview(converged.review, { now })).toMatchObject({
      ok: true,
      review: { status: "approved" },
    });
  });
});

function baseInput(now: () => string) {
  return {
    id: "rev_abc123",
    projectSlug: "repo",
    worktreeId: "wt_abc123def456",
    pr: 42,
    reviewer: "claude" as const,
    implementer: "codex" as const,
    maxRounds: 3,
    convergenceGate: "findings_only" as const,
    verificationCommands: [],
    now,
  };
}
