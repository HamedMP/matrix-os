import { randomUUID } from "node:crypto";
import type { AgentThreadEvent, AgentThreadSummary, CreateAgentTurnRequest } from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import {
  parseCodingAgentProviderRunResult,
  type CodingAgentProviderAdapter,
  type CodingAgentProviderResumeState,
} from "./provider-adapter.js";

const DEFAULT_MAX_DISPATCHES = 100;
const DEFAULT_TIMEOUT_MS = 120_000;

interface DispatchEntry {
  controller: AbortController;
  startedAtMs: number;
  abortReason?: "timeout" | "explicit" | "shutdown";
  promise?: Promise<void>;
}

export interface CodingAgentTurnDispatchReservation {
  id: string;
  entry: DispatchEntry;
}

export interface CodingAgentTurnDispatcherOptions {
  getProvider(providerId: string): CodingAgentProviderAdapter;
  markRunning(ownerId: string, threadId: string, turnId: string): Promise<void>;
  finish(input: {
    ownerId: string;
    threadId: string;
    turnId: string;
    providerEvents: AgentThreadEvent[];
    outcome: "completed" | "failed" | "aborted";
    resumeState?: CodingAgentProviderResumeState;
  }): Promise<void>;
  nextEventId(): string;
  now(): Date;
  logFailure(scope: string, err: unknown): void;
  maxDispatches?: number;
  timeoutMs?: number;
}

export interface CodingAgentTurnDispatchInput {
  principal: RequestPrincipal;
  thread: AgentThreadSummary;
  providerResumeState: CodingAgentProviderResumeState;
  turn: {
    turnId: string;
    message: string;
    attachments?: CreateAgentTurnRequest["attachments"];
  };
}

export function createCodingAgentTurnDispatcher(options: CodingAgentTurnDispatcherOptions) {
  const maxDispatches = Math.max(1, Math.min(
    options.maxDispatches ?? DEFAULT_MAX_DISPATCHES,
    DEFAULT_MAX_DISPATCHES,
  ));
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10 * 60_000));
  const active = new Map<string, DispatchEntry>();
  let closed = false;

  function sweepExpired(): void {
    const cutoff = Date.now() - timeoutMs;
    for (const entry of active.values()) {
      if (entry.startedAtMs <= cutoff) {
        entry.abortReason ??= "timeout";
        entry.controller.abort();
      }
    }
  }

  async function dispatch(input: CodingAgentTurnDispatchInput, entry: DispatchEntry): Promise<void> {
    const signal = entry.controller.signal;
    try {
      await options.markRunning(input.principal.userId, input.thread.id, input.turn.turnId);
      const provider = options.getProvider(input.thread.providerId);
      if (!provider.resumeTurn) throw new Error("Provider turn resume unavailable");
      const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const providerPromise = Promise.resolve().then(() => provider.resumeTurn!({
        principal: input.principal,
        thread: input.thread,
        turn: input.turn,
        resumeState: input.providerResumeState,
        signal: combinedSignal,
        now: options.now,
        nextEventId: options.nextEventId,
      }));
      const providerResult = await new Promise<Awaited<typeof providerPromise>>((resolve, reject) => {
        const rejectAborted = () => reject(new Error("Turn dispatch aborted"));
        if (combinedSignal.aborted) {
          rejectAborted();
          return;
        }
        combinedSignal.addEventListener("abort", rejectAborted, { once: true });
        providerPromise.then(resolve, reject).finally(() => {
          combinedSignal.removeEventListener("abort", rejectAborted);
        });
      });
      const parsed = parseCodingAgentProviderRunResult(providerResult, input.thread.id);
      if (!parsed.outcome) throw new Error("Provider turn outcome unavailable");
      await options.finish({
        ownerId: input.principal.userId,
        threadId: input.thread.id,
        turnId: input.turn.turnId,
        providerEvents: parsed.events,
        outcome: parsed.outcome,
        resumeState: parsed.resumeState,
      });
    } catch (err: unknown) {
      options.logFailure("provider turn failed", err);
      await options.finish({
        ownerId: input.principal.userId,
        threadId: input.thread.id,
        turnId: input.turn.turnId,
        providerEvents: [],
        outcome: entry.abortReason === "explicit" || entry.abortReason === "shutdown"
          ? "aborted"
          : "failed",
      });
    }
  }

  return {
    reserve(): CodingAgentTurnDispatchReservation | null {
      if (closed) return null;
      sweepExpired();
      if (active.size >= maxDispatches) return null;
      const reservation = {
        id: `reservation_${randomUUID()}`,
        entry: { controller: new AbortController(), startedAtMs: Date.now() },
      };
      active.set(reservation.id, reservation.entry);
      return reservation;
    },

    release(reservation: CodingAgentTurnDispatchReservation): void {
      active.delete(reservation.id);
    },

    start(reservation: CodingAgentTurnDispatchReservation, input: CodingAgentTurnDispatchInput): void {
      active.delete(reservation.id);
      reservation.entry.startedAtMs = Date.now();
      active.set(input.turn.turnId, reservation.entry);
      const promise = dispatch(input, reservation.entry)
        .catch((err: unknown) => options.logFailure("turn dispatch finalization failed", err))
        .finally(() => active.delete(input.turn.turnId));
      reservation.entry.promise = promise;
    },

    abort(turnId: string): void {
      const entry = active.get(turnId);
      if (!entry) return;
      entry.abortReason ??= "explicit";
      entry.controller.abort();
    },

    async shutdown(): Promise<void> {
      closed = true;
      for (const entry of active.values()) {
        entry.abortReason ??= "shutdown";
        entry.controller.abort();
      }
      await Promise.allSettled(
        [...active.values()]
          .map((entry) => entry.promise)
          .filter((promise): promise is Promise<void> => Boolean(promise)),
      );
      active.clear();
    },
  };
}

export type CodingAgentTurnDispatcher = ReturnType<typeof createCodingAgentTurnDispatcher>;
