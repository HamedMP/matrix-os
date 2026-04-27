import type { SupportedAgent } from "./agent-launcher.js";
import type { FindingsParseFailure, FindingsParseSuccess } from "./findings-parser.js";
import type { WorkspaceError } from "./project-manager.js";

export type ReviewStatus =
  | "queued"
  | "reviewing"
  | "implementing"
  | "verifying"
  | "converged"
  | "stalled"
  | "failed"
  | "failed_parse"
  | "stopped"
  | "approved";

export interface ReviewRoundRecord {
  round: number;
  phase: "review" | "implement" | "verify";
  sessionId?: string;
  findingsPath?: string;
  controlPath?: string;
  parserStatus?: "not_started" | "success" | "failed";
  findingsCount?: number;
  severityCounts?: { high: number; medium: number; low: number };
  implementerCommit?: string;
  startedAt: string;
  completedAt?: string;
  error?: { code: string; message: string };
}

export interface ReviewLoopRecord {
  id: string;
  projectSlug: string;
  worktreeId: string;
  pr: number;
  status: ReviewStatus;
  round: number;
  maxRounds: number;
  reviewer: SupportedAgent;
  implementer: SupportedAgent;
  convergenceGate: "findings_only" | "findings_and_verify";
  verificationCommands: string[];
  activeSessionId?: string;
  leaseId?: string;
  rounds: ReviewRoundRecord[];
  createdAt: string;
  updatedAt: string;
}

type Failure = {
  ok: false;
  status: number;
  error: WorkspaceError;
};

type Result = { ok: true; review: ReviewLoopRecord } | Failure;

function nowIso(now?: () => string): string {
  return now ? now() : new Date().toISOString();
}

function failure(code = "illegal_review_transition", message = "Review transition is not allowed"): Failure {
  return { ok: false, status: 409, error: { code, message } };
}

function terminal(status: ReviewStatus): boolean {
  return ["converged", "stalled", "failed", "failed_parse", "stopped", "approved"].includes(status);
}

function replaceCurrentRound(review: ReviewLoopRecord, round: ReviewRoundRecord): ReviewRoundRecord[] {
  return review.rounds.map((entry, index) => index === review.rounds.length - 1 ? round : entry);
}

export function createReviewLoopRecord(input: {
  id: string;
  projectSlug: string;
  worktreeId: string;
  pr: number;
  reviewer: SupportedAgent;
  implementer: SupportedAgent;
  maxRounds: number;
  convergenceGate: "findings_only" | "findings_and_verify";
  verificationCommands: string[];
  now?: () => string;
}): ReviewLoopRecord {
  const timestamp = nowIso(input.now);
  return {
    id: input.id,
    projectSlug: input.projectSlug,
    worktreeId: input.worktreeId,
    pr: input.pr,
    status: "queued",
    round: 0,
    maxRounds: input.maxRounds,
    reviewer: input.reviewer,
    implementer: input.implementer,
    convergenceGate: input.convergenceGate,
    verificationCommands: input.verificationCommands,
    rounds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function startNextReviewRound(
  review: ReviewLoopRecord,
  input: { sessionId: string; now?: () => string },
): Result {
  if (!["queued", "implementing"].includes(review.status)) {
    return failure();
  }
  if (review.round >= review.maxRounds) {
    return {
      ok: true,
      review: {
        ...review,
        status: "stalled",
        activeSessionId: undefined,
        updatedAt: nowIso(input.now),
      },
    };
  }
  const timestamp = nowIso(input.now);
  const nextRound = review.status === "queued" ? 1 : review.round + 1;
  return {
    ok: true,
    review: {
      ...review,
      status: "reviewing",
      round: nextRound,
      activeSessionId: input.sessionId,
      updatedAt: timestamp,
      rounds: [
        ...review.rounds,
        {
          round: nextRound,
          phase: "review",
          sessionId: input.sessionId,
          parserStatus: "not_started",
          startedAt: timestamp,
        },
      ],
    },
  };
}

export function completeReview(
  review: ReviewLoopRecord,
  input: {
    parseResult: FindingsParseSuccess | FindingsParseFailure;
    now?: () => string;
  },
): Result {
  if (review.status !== "reviewing" || review.rounds.length === 0) {
    return failure();
  }
  const timestamp = nowIso(input.now);
  const current = review.rounds[review.rounds.length - 1]!;
  if (!input.parseResult.ok) {
    const round: ReviewRoundRecord = {
      ...current,
      parserStatus: "failed",
      completedAt: timestamp,
      error: input.parseResult.error,
    };
    return {
      ok: true,
      review: {
        ...review,
        status: "failed_parse",
        activeSessionId: undefined,
        rounds: replaceCurrentRound(review, round),
        updatedAt: timestamp,
      },
    };
  }

  const round: ReviewRoundRecord = {
    ...current,
    parserStatus: "success",
    findingsCount: input.parseResult.findingsCount,
    severityCounts: input.parseResult.severityCounts,
    completedAt: timestamp,
  };
  if (input.parseResult.findingsCount === 0) {
    const nextStatus = review.convergenceGate === "findings_and_verify" ? "verifying" : "converged";
    const verifyRound: ReviewRoundRecord[] = nextStatus === "verifying"
      ? [{
        round: review.round,
        phase: "verify",
        startedAt: timestamp,
      }]
      : [];
    return {
      ok: true,
      review: {
        ...review,
        status: nextStatus,
        activeSessionId: undefined,
        rounds: [...replaceCurrentRound(review, round), ...verifyRound],
        updatedAt: timestamp,
      },
    };
  }
  return {
    ok: true,
    review: {
      ...review,
      status: review.round >= review.maxRounds ? "stalled" : "implementing",
      activeSessionId: undefined,
      rounds: replaceCurrentRound(review, round),
      updatedAt: timestamp,
    },
  };
}

export function completeImplementation(
  review: ReviewLoopRecord,
  input: { sessionId: string; commit: string; now?: () => string },
): Result {
  if (review.status !== "implementing" || review.rounds.length === 0) {
    return failure();
  }
  const timestamp = nowIso(input.now);
  const current = review.rounds[review.rounds.length - 1]!;
  const completed: ReviewRoundRecord = {
    ...current,
    phase: "implement",
    sessionId: current.sessionId,
    implementerCommit: input.commit,
    completedAt: timestamp,
  };
  const updated: ReviewLoopRecord = {
    ...review,
    status: "implementing",
    rounds: replaceCurrentRound(review, completed),
    updatedAt: timestamp,
  };
  return startNextReviewRound(updated, { sessionId: input.sessionId, now: input.now });
}

export function completeVerification(
  review: ReviewLoopRecord,
  input: { passed: boolean; now?: () => string },
): Result {
  if (review.status !== "verifying") {
    return failure();
  }
  const timestamp = nowIso(input.now);
  const rounds = [...review.rounds];
  const last = rounds[rounds.length - 1];
  if (last?.phase === "verify") {
    rounds[rounds.length - 1] = {
      ...last,
      completedAt: timestamp,
      error: input.passed ? undefined : { code: "verification_failed", message: "Verification failed" },
    };
  }
  return {
    ok: true,
    review: {
      ...review,
      status: input.passed ? "converged" : "failed",
      rounds,
      updatedAt: timestamp,
    },
  };
}

export function stopReview(review: ReviewLoopRecord, input: { now?: () => string }): Result {
  if (["converged", "stopped", "approved"].includes(review.status)) {
    return failure();
  }
  return {
    ok: true,
    review: {
      ...review,
      status: "stopped",
      activeSessionId: undefined,
      updatedAt: nowIso(input.now),
    },
  };
}

export function approveReview(review: ReviewLoopRecord, input: { now?: () => string }): Result {
  if (!terminal(review.status) || ["converged", "stopped", "approved"].includes(review.status)) {
    return failure();
  }
  return {
    ok: true,
    review: {
      ...review,
      status: "approved",
      activeSessionId: undefined,
      updatedAt: nowIso(input.now),
    },
  };
}
