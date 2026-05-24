import { randomUUID } from "node:crypto";
import type { AgentId } from "./activation-contracts.js";
import { ActivationRouteError } from "./activation-errors.js";

const MAX_OWNERS = 512;
const MAX_DRAFTS_PER_OWNER = 200;
const UNSAFE_DISPLAY = /(sk_[a-z0-9][a-z0-9_-]*|\/home\/[^\s,;]+|[A-Za-z0-9_.-]*(?:secret|token)[A-Za-z0-9_.-]*\s*[:=]\s*[^\s,;]+)/gi;
const SENSITIVE_TERMS = /\b(secret|token|postgres|database)\b/gi;

export type DraftActionType = "support_reply" | "social_post" | "acquisition_message" | "customer_follow_up";
export type DraftActionStatus = "draft" | "needs_review" | "approved" | "sent" | "rejected";

export interface DraftUncertainty {
  kind: "uncertainty" | "sensitive_claim";
  message: string;
}

export interface DraftAction {
  id: string;
  type: DraftActionType;
  status: DraftActionStatus;
  content: string;
  destination: string;
  uncertainties: DraftUncertainty[];
  createdByAgent: AgentId;
  createdAt: string;
  approvalSummary?: string;
}

export interface DraftActionReadiness {
  status: "ready" | "needs_review";
  pendingReview: number;
  approved: number;
  guidance: string;
  drafts: DraftAction[];
}

export interface DraftActionReadinessService {
  getReadiness(ownerId: string): Promise<DraftActionReadiness>;
  createDraft(ownerId: string, input: {
    type: DraftActionType;
    content: string;
    destination: string;
    createdByAgent: AgentId;
  }): Promise<DraftAction>;
  approveDraft(ownerId: string, draftId: string, approved: boolean): Promise<DraftAction>;
}

function safeDisplay(value: string, fallback: string, max = 5000): string {
  const trimmed = value.trim().slice(0, max);
  if (!trimmed) return fallback;
  const redacted = trimmed
    .replace(UNSAFE_DISPLAY, "[redacted]")
    .replace(SENSITIVE_TERMS, "[redacted]")
    .trim();
  return redacted || fallback;
}

function uncertaintyFlags(content: string): DraftUncertainty[] {
  const lower = content.toLowerCase();
  const flags: DraftUncertainty[] = [];
  if (lower.includes("unsure") || lower.includes("unknown") || lower.includes("may ") || lower.includes("might ")) {
    flags.push({ kind: "uncertainty", message: "Confirm timing, facts, or missing context before sending." });
  }
  if (lower.includes("guarantee") || lower.includes("99.999") || /\b(?:always|never)\b/.test(lower)) {
    flags.push({ kind: "sensitive_claim", message: "Review sensitive or absolute claims before approval." });
  }
  return flags;
}

export function createDraftActionReadinessService(options: {
  now?: () => Date;
} = {}): DraftActionReadinessService {
  const now = options.now ?? (() => new Date());
  const ownerDrafts = new Map<string, DraftAction[]>();

  function draftsFor(ownerId: string): DraftAction[] {
    const existing = ownerDrafts.get(ownerId);
    if (existing) {
      ownerDrafts.delete(ownerId);
      ownerDrafts.set(ownerId, existing);
      return existing;
    }
    if (ownerDrafts.size >= MAX_OWNERS) {
      const oldestKey = ownerDrafts.keys().next().value as string | undefined;
      if (oldestKey) ownerDrafts.delete(oldestKey);
    }
    const next: DraftAction[] = [];
    ownerDrafts.set(ownerId, next);
    return next;
  }

  async function getReadiness(ownerId: string): Promise<DraftActionReadiness> {
    const drafts = draftsFor(ownerId);
    const pendingReview = drafts.filter((draft) => draft.status === "needs_review").length;
    const approved = drafts.filter((draft) => draft.status === "approved").length;
    return {
      status: pendingReview > 0 ? "needs_review" : "ready",
      pendingReview,
      approved,
      guidance: pendingReview > 0
        ? "Review drafts before any external send or publish action."
        : "Support and growth drafts are approval-first.",
      drafts: [...drafts],
    };
  }

  async function createDraft(ownerId: string, input: {
    type: DraftActionType;
    content: string;
    destination: string;
    createdByAgent: AgentId;
  }): Promise<DraftAction> {
    const drafts = draftsFor(ownerId);
    const safeContent = safeDisplay(input.content, "Draft needs review");
    const draft: DraftAction = {
      id: `draft.${randomUUID()}`,
      type: input.type,
      status: "needs_review",
      content: safeContent,
      destination: safeDisplay(input.destination, "External destination", 220),
      uncertainties: uncertaintyFlags(input.content),
      createdByAgent: input.createdByAgent,
      createdAt: now().toISOString(),
    };
    drafts.push(draft);
    while (drafts.length > MAX_DRAFTS_PER_OWNER) drafts.shift();
    return draft;
  }

  async function approveDraft(ownerId: string, draftId: string, approved: boolean): Promise<DraftAction> {
    const draft = draftsFor(ownerId).find((candidate) => candidate.id === draftId);
    if (!draft) {
      throw new ActivationRouteError("draft_not_found", "Draft was not found", { status: 404 });
    }
    if (draft.status === "approved" || draft.status === "sent" || draft.status === "rejected") {
      throw new ActivationRouteError("draft_already_decided", "Draft has already been decided", { status: 409 });
    }
    draft.status = approved ? "approved" : "rejected";
    draft.approvalSummary = approved ? "Draft approved for external action" : "Draft rejected";
    return draft;
  }

  return { getReadiness, createDraft, approveDraft };
}
