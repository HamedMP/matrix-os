import { randomUUID } from "./random-uuid.js";
import { CanonicalCreateChatTurnRequestSchema, CanonicalChatTurnAdmissionResponseSchema, type CanonicalChatDetailResponse, type CanonicalChatRecord,
  type CanonicalChatTurnAdmissionResponse, type CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import type { CanonicalChatClientAdmission } from "./canonical-chat-admission-recovery.js";

export const CHAT_ADMISSION_UNCONFIRMED = "Message status is unconfirmed. You can retry safely.";
export class ChatAdmissionUnconfirmed extends Error {
  constructor(cause?: unknown) { super(CHAT_ADMISSION_UNCONFIRMED, { cause }); this.name = "ChatAdmissionUnconfirmed"; }
}
type Input = Omit<CanonicalCreateChatTurnRequest, "clientRequestId" | "baseRevision">;
const InputSchema = CanonicalCreateChatTurnRequestSchema.omit({ clientRequestId: true, baseRevision: true });
export interface ChatAdmissionAttempt {
  identity: unknown; scope: string; payload: string; sourcePayload?: string; seed?: string; id: string;
  record?: CanonicalChatRecord; request?: CanonicalCreateChatTurnRequest;
  accepted?: CanonicalChatTurnAdmissionResponse;
  uncertain?: boolean;
  notify?: () => void;
  confirmed?: () => void;
  resolve: (value: CanonicalChatTurnAdmissionResponse) => void;
  receipt: Promise<CanonicalChatTurnAdmissionResponse>;
  inFlight?: Promise<CanonicalChatTurnAdmissionResponse>;
  reading?: Promise<void>;
  read?: () => Promise<CanonicalChatDetailResponse>;
  isCurrent?: () => boolean;
  canAcknowledge?: () => boolean;
  lastRead: number;
}

/**
 * Only an exact durable turn plus its linked user message and run proves
 * admission. The confirming read's full detail travels with the receipt: it can
 * be newer than the admission (a fast run may already have replied), and a
 * detail rebuilt from the receipt alone would drop that transcript.
 */
function receipt(attempt: ChatAdmissionAttempt, detail: CanonicalChatDetailResponse): CanonicalChatClientAdmission | undefined {
  if (detail.record.chat.id !== attempt.record?.chat.id) return;
  const turn = detail.turns.find(item => item.chatId === detail.record.chat.id && item.clientRequestId === attempt.id);
  if (!turn) return;
  const message = detail.messages.find(item => item.id === turn.inputMessageId && item.turnId === turn.id && item.role === "user" && item.state === "committed");
  const run = detail.runs.find(item => item.turnId === turn.id && item.attempt === 1);
  if (!message || !run) return;
  const parsed = CanonicalChatTurnAdmissionResponseSchema.safeParse({ record: detail.record, turn, message, run, admission: "already_accepted" });
  return parsed.success ? { ...parsed.data, recoveredDetail: detail } : undefined;
}

/** Unknown entries never expire/evict into a new request id. Explicit calls alone may POST. */
export function createCanonicalChatAdmissionTracker() {
  const attempts: ChatAdmissionAttempt[] = []; // at most 100 unresolved; known dispositions remove entries
  const complete = (attempt: ChatAdmissionAttempt, accepted: CanonicalChatTurnAdmissionResponse) => {
    if (attempt.accepted) return attempt.accepted;
    attempt.accepted = accepted;
    const index = attempts.indexOf(attempt);
    if (index >= 0) attempts.splice(index, 1);
    attempt.resolve(accepted);
    {
      const callbacks = [
        (attempt.canAcknowledge?.() ?? attempt.isCurrent?.()) ? attempt.notify : undefined,
        attempt.isCurrent?.() ? attempt.confirmed : undefined,
      ];
      for (const callback of callbacks) {
        try { callback?.(); }
        catch (error) { console.warn("[chat] Admission acknowledgement unavailable", error instanceof Error ? error.name : "UnknownError"); }
      }
    }
    return accepted;
  };
  const observe = (identity: unknown, detail: CanonicalChatDetailResponse | null) => {
    if (!detail) return;
    for (const attempt of [...attempts]) {
      if (attempt.identity !== identity || !attempt.isCurrent?.()) continue;
      const accepted = receipt(attempt, detail);
      if (accepted) complete(attempt, accepted);
    }
  };
  const read = (attempt: ChatAdmissionAttempt) => {
    if (attempt.reading) return attempt.reading;
    if (!attempt.read || !attempt.isCurrent?.()) return Promise.resolve();
    attempt.lastRead = Date.now();
    attempt.reading = attempt.read().then(detail => { observe(attempt.identity, detail); }, error => {
      console.warn("[chat] Admission status unavailable", error instanceof Error ? error.name : "UnknownError");
    }).finally(() => { attempt.reading = undefined; });
    return attempt.reading;
  };
  return {
    prepare(identity: unknown, scope: string, value: Input, seed?: string, resolveInput?: (input: Input) => Input): ChatAdmissionAttempt {
      const input = InputSchema.parse(value);
      if (seed !== undefined) CanonicalCreateChatTurnRequestSchema.shape.clientRequestId.parse(seed);
      const sourcePayload = JSON.stringify(input);
      const previous = attempts.find(item => item.identity === identity && item.scope === scope
        && (item.sourcePayload ?? item.payload) === sourcePayload && item.seed === seed);
      if (previous) return previous;
      if (attempts.length >= 100) throw new ChatAdmissionUnconfirmed();
      // An uncertain admission retries the same request even if Chat state has changed.
      const payload = resolveInput ? JSON.stringify(resolveInput(input)) : sourcePayload;
      let resolve!: ChatAdmissionAttempt["resolve"];
      const promise = new Promise<CanonicalChatTurnAdmissionResponse>(value => { resolve = value; });
      const attempt: ChatAdmissionAttempt = { identity, scope, payload, seed,
        ...(payload === sourcePayload ? {} : { sourcePayload }),
        id: seed && !attempts.some(item => item.identity === identity && item.scope === scope && item.id === seed)
          ? seed : `req_${randomUUID().replaceAll("-", "")}`, resolve, receipt: promise, lastRead: 0 };
      attempts.push(attempt);
      return attempt;
    },
    hasUnresolved(identity: unknown, scope: string, value?: Input) {
      const payload = value === undefined ? undefined : JSON.stringify(InputSchema.parse(value));
      return attempts.some(item => item.identity === identity && item.scope === scope
        && (payload === undefined || (item.sourcePayload ?? item.payload) === payload));
    },
    bind(attempt: ChatAdmissionAttempt, record: CanonicalChatRecord) {
      attempt.record ??= record;
      attempt.request ??= { ...JSON.parse(attempt.payload), clientRequestId: attempt.id, baseRevision: record.chat.revision };
      return attempt.request;
    },
    observe,
    invalidate(identity: unknown, chatId?: string) {
      for (const attempt of attempts) if (attempt.identity === identity && attempt.request
        && (!chatId || attempt.record?.chat.id === chatId) && Date.now() - attempt.lastRead >= 200) void read(attempt);
    },
    send(attempt: ChatAdmissionAttempt, options: {
      post: (request: CanonicalCreateChatTurnRequest) => Promise<CanonicalChatTurnAdmissionResponse>;
      read: () => Promise<CanonicalChatDetailResponse>;
      current: () => CanonicalChatDetailResponse | null;
      isCurrent: () => boolean; onAccepted: () => void;
      canAcknowledge?: () => boolean;
      onConfirmed?: () => void; onRejected?: () => void;
      definitive: (error: unknown) => boolean;
    }) {
      if (attempt.accepted) return Promise.resolve(attempt.accepted);
      attempt.notify ??= options.onAccepted;
      attempt.canAcknowledge ??= options.canAcknowledge;
      attempt.confirmed = options.onConfirmed;
      attempt.isCurrent = options.isCurrent;
      attempt.read = options.read;
      if (attempt.inFlight) return attempt.inFlight;
      const task = (async () => {
        try { return complete(attempt, await options.post(attempt.request!)); }
        catch (error) {
          if (attempt.accepted) return attempt.accepted;
          observe(attempt.identity, options.current());
          if (attempt.accepted) return attempt.accepted;
          if (options.definitive(error) && !attempt.uncertain) {
            const index = attempts.indexOf(attempt);
            if (index >= 0) attempts.splice(index, 1);
            options.onRejected?.();
            throw error;
          }
          attempt.uncertain = true;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([read(attempt), new Promise<void>(resolve => { timer = setTimeout(resolve, 3_000); })]); }
          finally { if (timer) clearTimeout(timer); }
          if (attempt.accepted) return attempt.accepted;
          throw new ChatAdmissionUnconfirmed(error);
        }
      })();
      attempt.inFlight = Promise.race([task, attempt.receipt]).finally(() => { attempt.inFlight = undefined; });
      return attempt.inFlight;
    },
  };
}
