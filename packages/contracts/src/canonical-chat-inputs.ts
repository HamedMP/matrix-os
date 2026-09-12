import { CanonicalSubmitChatInputRequestSchema, type CanonicalSubmitChatInputRequest, type CanonicalChatDetailResponse } from "#canonical-chat-api";
import type { CanonicalChatRunActivity } from "#canonical-chat";
type Request = Extract<CanonicalChatRunActivity, { type: "input.requested" }>;
export interface CanonicalChatInputView {
  id: string;
  runId: string;
  requestId: string;
  title: string;
  safeDescription?: string;
  questions?: Request["questions"];
  expiresAt?: string;
  pending: boolean;
  submitted: boolean;
  resolved: boolean;
  reason?: "answered" | "cancelled" | "expired";
  timestamp: number;
  beforeMessageId?: string;
}
/** Request-local collections are bounded by the detail schema; no answers are retained. */
export function canonicalChatInputs(detail: Pick<CanonicalChatDetailResponse, "runs" | "turns" | "messages" | "activities">, now = Date.now()): CanonicalChatInputView[] {
  const requests = new Map<string, Request>();
  const resolved = new Set<string>();
  const submitted = new Set<string>();
  const reasons = new Map<string, CanonicalChatInputView["reason"]>();
  const key = (runId: string, requestId: string) => `${runId}\0${requestId}`;
  for (const activity of detail.activities) {
    if (activity.type === "input.requested") requests.set(key(activity.runId, activity.requestId), activity);
    if (activity.type === "input.resolved") {
      resolved.add(key(activity.runId, activity.requestId));
      reasons.set(key(activity.runId, activity.requestId), activity.reason);
    }
    if (activity.type === "input.submitted") submitted.add(key(activity.runId, activity.requestId));
  }
  return [...requests.entries()].flatMap(([identity, request]) => {
    const run = detail.runs.find(run => run.id === request.runId);
    if (!run) return [];
    const turn = detail.turns.find(turn => turn.id === run.turnId);
    const input = detail.messages.find(message => message.id === turn?.inputMessageId);
    const next = input && detail.messages.find(message => message.role === "user" && message.seq > input.seq && message.turnId !== run.turnId);
    return [{ ...request, submitted: submitted.has(identity), resolved: resolved.has(identity), reason: reasons.get(identity),
      pending: !!request.questions?.length && !resolved.has(identity) && !submitted.has(identity)
        && ["accepted", "running", "waiting_for_input", "waiting_for_approval"].includes(run.status)
        && (!request.expiresAt || Date.parse(request.expiresAt) > now),
      timestamp: Date.parse(request.occurredAt), ...(next ? { beforeMessageId: next.id } : {}),
    }];
  });
}

/** Shared form validation; native transports still validate against their pending request. */
export function buildCanonicalChatInputAnswer(request: Pick<CanonicalChatInputView, "questions">, answers: Record<string, string[]>): Omit<CanonicalSubmitChatInputRequest, "clientRequestId"> | null {
  const parsed = CanonicalSubmitChatInputRequestSchema.safeParse({ clientRequestId: "req_validation", structuredAnswers: answers });
  if (!parsed.success || !request.questions?.length) return null;
  const values = parsed.data.structuredAnswers!;
  if (Object.keys(values).length !== request.questions.length) return null;
  for (const question of request.questions) {
    const selected = values[question.questionId];
    if (!selected?.length || new Set(selected).size !== selected.length || (!question.multiSelect && selected.length !== 1)) return null;
    if (question.options?.length && !question.allowOther && selected.some(value => !question.options?.some(option => option.label === value))) return null;
  }
  return { structuredAnswers: values };
}
