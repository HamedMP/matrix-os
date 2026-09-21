import { ChatSteerNotDeliveredError } from "./steer-delivery-error.js";
import { ChatInputNotDeliveredError } from "./input-delivery-error.js";
import { BackgroundProjectionDetached } from "./background-run-control.js";
import { createHash } from "node:crypto";
import { ASYNC_QUESTION_NOTICE } from "../coding-agents/async-input-notice.mjs";
import type { CanonicalSubmitChatInputRequest } from "@matrix-os/contracts";
import type { AiTokenUsage } from "../domains/observability/ai-analytics.js";
import { ChatInputAnswerValidationError, validateChatInputAnswer } from "./input-submission.js";
import type { CanonicalChatProviderAdapter, CanonicalProviderRunEvent, CanonicalProviderRunInput } from "./provider-adapter.js";

const ASYNC_PROMPT = `\n\n[Matrix question delivery]\nQuestions are asynchronous. ${ASYNC_QUESTION_NOTICE}`;
type Question = Extract<CanonicalProviderRunEvent, { type: "input.requested" }>;
type Answer = { request: Question; input: CanonicalSubmitChatInputRequest };
type Steer = Parameters<NonNullable<CanonicalChatProviderAdapter["steer"]>>[0];
type Receipt = { resolve(): void; reject(error: Error): void };
type Continuation = { kind: "answer"; answer: Answer } | { kind: "steer"; input: Steer; receipt: Receipt };
type Run = {
  input: CanonicalProviderRunInput;
  pending: Map<string, { request: Question; timer: ReturnType<typeof setTimeout> }>;
  deferred: Set<string>;
  nativeOnly: Set<string>;
  continuations: Continuation[];
  nativeActive: boolean;
  resumable: boolean;
  expired: CanonicalProviderRunEvent[];
  wake?: () => void;
};

/** A native phase can finish while questions remain open. The canonical Run stays alive.
 * Late answers enter the same native conversation at its next safe turn boundary.
 * Registries are capped; each question expires and every Run drains on cancellation.
 */
export function withAsyncChatInput(native: CanonicalChatProviderAdapter, options: { questionTimeoutMs?: number } = {}): CanonicalChatProviderAdapter {
  if (!native.deferInput || !native.resume) return native;
  const runs = new Map<string, Run>();
  const timeout = Math.max(1, Math.min(options.questionTimeoutMs ?? 60 * 60_000, 60 * 60_000));
  const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

  async function* execute(input: CanonicalProviderRunInput): AsyncIterable<CanonicalProviderRunEvent> {
    if (runs.has(input.runId) || runs.size >= 128) throw new Error("Async question Run unavailable");
    const run: Run = { input, pending: new Map(), deferred: new Set(), nativeOnly: new Set(), continuations: [], nativeActive: true, resumable: false, expired: [] };
    runs.set(input.runId, run);
    const wake = () => { run.wake?.(); run.wake = undefined; };
    input.signal.addEventListener("abort", wake);
    let state = input.resumeState;
    let phase = 0;
    let continuation: Continuation | undefined;
    let tokenUsage: AiTokenUsage | undefined;
    let lastTerminal: Extract<CanonicalProviderRunEvent, { type: "run.completed" }> = { type: "run.completed", outcome: "completed" };
    try {
      while (!input.signal.aborted) {
        const phaseAnswers = continuation?.kind === "answer" ? [continuation.answer] : [];
        const prompt = continuation?.kind === "steer" ? `${continuation.input.prompt}${ASYNC_PROMPT}` : phase === 0 ? input.prompt :
          `[Matrix: answers to your earlier asynchronous questions]\n${JSON.stringify(phaseAnswers.map(answer => ({ requestId: answer.request.requestId, questions: answer.request.questions?.map(question => ({ questionId: question.questionId, question: question.question })), answers: answer.input.structuredAnswers ?? answer.input.answer })))}\nApply these user answers to the pending work. Do not ask the same questions again.${ASYNC_PROMPT}`;
        const parts = continuation?.kind === "steer" ? continuation.input.parts : phase === 0 ? input.parts : [{ type: "text" as const, text: prompt }];
        run.nativeActive = true;
        const next = { ...input, prompt, parts, ...(state === undefined ? {} : { resumeState: state }),
          ...(phase ? { continuationId: `run_async_${digest(`${input.runId}:${phase}`)}` } : {}) };
        const source = state === undefined ? native.start(next) : native.resume!({ ...next, resumeState: state });
        let terminal: typeof lastTerminal | undefined;
        let answersConfirmed = phaseAnswers.length === 0;
        for await (const event of source) {
          if (input.signal.aborted) break;
          while (run.expired.length) yield run.expired.shift()!;
          if (terminal) throw new Error("Native phase emitted after completion");
          if (!answersConfirmed && (event.type === "assistant.delta" || event.type === "tool.progress" || event.type === "input.requested" || (event.type === "run.completed" && event.outcome === "completed"))) {
            answersConfirmed = true;
            for (const answer of phaseAnswers) yield { type: "input.resolved", requestId: answer.request.requestId, reason: "answered" };
          }
          if (continuation?.kind === "steer" && (event.type === "assistant.delta" || event.type === "tool.progress" || event.type === "input.requested" || (event.type === "run.completed" && event.outcome === "completed"))) {
            continuation.receipt.resolve();
          }
          if (event.type === "state.updated") { state = native.parseState(event.state); run.resumable = true; }
          if (event.type === "input.requested" && event.questions?.length) {
            // A resumed user prompt is persisted by coding providers. Secret answers must
            // remain on the original ephemeral native tool channel instead.
            if (event.questions.some(question => question.secret)) {
              if (run.nativeOnly.size >= 16) throw new Error("Native question limit exceeded");
              run.nativeOnly.add(event.requestId);
              yield event;
              continue;
            }
            if (run.deferred.has(event.requestId)) continue;
            if (run.pending.size >= 16 || run.deferred.size >= 64) throw new Error("Async question limit exceeded");
            const request = { ...event, asynchronous: true, expiresAt: new Date(Date.now() + timeout).toISOString(), safeDescription: "You can answer while work continues. Only work that needs your answer will wait." };
            const timer = setTimeout(() => {
              if (run.pending.delete(request.requestId)) run.expired.push({ type: "input.resolved", requestId: request.requestId, reason: "expired" });
              wake();
            }, timeout);
            timer.unref?.();
            run.pending.set(request.requestId, { request, timer }); run.deferred.add(request.requestId);
            // The consumer persists the visible question before the native tool is released.
            yield request;
            await native.deferInput!({ owner: input.owner, chatId: input.chatId, runId: input.runId, requestId: request.requestId });
            continue;
          }
          // Native tool acknowledgement is not a user answer. Only the later answer phase resolves it.
          if (event.type === "input.resolved" && run.deferred.has(event.requestId)) continue;
          if (event.type === "input.resolved") run.nativeOnly.delete(event.requestId);
          if (event.type === "run.completed") { terminal = event; continue; }
          yield event.type === "assistant.delta" && phase ? { ...event, messageId: `async_${digest(`${phase}:${event.messageId ?? "answer"}`)}` } : event;
        }
        if (input.signal.aborted) break;
        if (!terminal) throw new Error("Native phase ended without completion");
        if (terminal.tokenUsage) {
          const usage = terminal.tokenUsage;
          const sum = (key: keyof AiTokenUsage) => Math.min(Number.MAX_SAFE_INTEGER, (tokenUsage?.[key] ?? 0) + (usage[key] ?? 0));
          tokenUsage = { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"),
            ...(tokenUsage?.cachedInputTokens !== undefined || usage.cachedInputTokens !== undefined ? { cachedInputTokens: sum("cachedInputTokens") } : {}),
            ...(tokenUsage?.reasoningOutputTokens !== undefined || usage.reasoningOutputTokens !== undefined ? { reasoningOutputTokens: sum("reasoningOutputTokens") } : {}) };
        }
        lastTerminal = { ...terminal, ...(tokenUsage ? { tokenUsage } : {}) };
        if (terminal.outcome !== "completed") break;
        run.resumable = state !== undefined;
        run.nativeActive = false;
        while (!input.signal.aborted && run.pending.size && !run.continuations.length) {
          while (run.expired.length) yield run.expired.shift()!;
          if (!run.pending.size) break;
          await new Promise<void>(resolve => { run.wake = resolve; if (input.signal.aborted || run.continuations.length) wake(); });
        }
        while (run.expired.length) yield run.expired.shift()!;
        if (input.signal.aborted || !run.continuations.length) break;
        if (state === undefined) throw new Error("Native conversation cannot resume for a continuation");
        // Drain answers and corrections in arrival order, one bounded payload per phase.
        continuation = run.continuations.shift(); phase++;
      }
      if (native.detachOnShutdown && input.signal.reason instanceof BackgroundProjectionDetached) return;
      for (const requestId of run.pending.keys()) yield { type: "input.resolved", requestId, reason: "cancelled" };
      yield input.signal.aborted ? { type: "run.completed", outcome: "aborted", ...(tokenUsage ? { tokenUsage } : {}) } : lastTerminal;
    } finally {
      const undelivered = new ChatSteerNotDeliveredError();
      if (continuation?.kind === "steer") continuation.receipt.reject(new Error("Steering delivery was not confirmed"));
      for (const queued of run.continuations) if (queued.kind === "steer") queued.receipt.reject(undelivered);
      for (const pending of run.pending.values()) clearTimeout(pending.timer);
      run.pending.clear(); run.deferred.clear(); run.nativeOnly.clear(); run.continuations.length = 0; run.expired.length = 0;
      input.signal.removeEventListener("abort", wake); wake(); runs.delete(input.runId);
    }
  }
  return {
    ...native, start: execute, resume: execute,
    ...(native.steer ? { async steer(input: Steer) {
      const run = runs.get(input.runId);
      if (!run || run.input.signal.aborted || run.input.chatId !== input.chatId || run.input.turnId !== input.turnId
        || run.input.owner.type !== input.owner.type || run.input.owner.ownerId !== input.owner.ownerId) {
        throw new Error("Steering Run unavailable");
      }
      // Never replay an uncertain native delivery. Only a completed native phase
      // can accept a correction as a continuation of the canonical Run.
      if (run.nativeActive && !run.continuations.length) {
        try { return await native.steer!(input); } catch (error: unknown) {
          // A released registry is a definite non-delivery, unlike an RPC timeout.
          if (!(error instanceof ChatSteerNotDeliveredError)) throw error;
        }
      }
      if (runs.get(input.runId) !== run || run.input.signal.aborted || !run.resumable || run.continuations.length >= 16) throw new Error("Steering Run unavailable");
      // Success requires evidence from the resumed provider, not an in-memory enqueue.
      return new Promise<void>((resolve, reject) => {
        run.continuations.push({ kind: "steer", input, receipt: { resolve, reject } });
        run.wake?.(); run.wake = undefined;
      });
    } } : {}),
    async submitInput(input) {
      const run = runs.get(input.runId);
      if (!run || run.input.signal.aborted || run.input.chatId !== input.chatId || run.input.owner.type !== input.owner.type || run.input.owner.ownerId !== input.owner.ownerId) throw new ChatInputNotDeliveredError();
      if (run.nativeOnly.has(input.requestId)) {
        if (!native.submitInput) throw new Error("Native question unavailable");
        run.nativeOnly.delete(input.requestId);
        return native.submitInput(input);
      }
      const pending = run.pending.get(input.requestId);
      if (!pending) throw new ChatInputNotDeliveredError();
      try { validateChatInputAnswer(pending.request, input); } catch (error: unknown) {
        if (error instanceof ChatInputAnswerValidationError) throw new ChatInputNotDeliveredError();
        throw error;
      }
      if (run.continuations.length >= 16) throw new ChatInputNotDeliveredError();
      clearTimeout(pending.timer); run.pending.delete(input.requestId);
      run.continuations.push({ kind: "answer", answer: { request: pending.request, input } }); run.wake?.(); run.wake = undefined;
      return "queued";
    },
  };
}
