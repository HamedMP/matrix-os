import type { GetStartedAnswers } from "@matrix-os/contracts";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

interface AnswersStore {
  answers: GetStartedAnswers | null;
  ended: boolean;
  finishedNow: boolean;
  publish(answers: GetStartedAnswers | null, ended: boolean, finishedNow: boolean): void;
  consumeFinishedNow(): void;
}

const AnswersContext = createContext<AnswersStore | null>(null);

/**
 * Spec 635, Section 5: shares the owner's saved answers with the rest of the desktop
 * (Getting started, the onboarding widget). Mount next to `GettingStartedVisibilityProvider`;
 * a scope change (account, computer or runtime) starts empty.
 */
export function GetStartedAnswersProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const [held, setHeld] = useState<{ scope: string; answers: GetStartedAnswers | null; ended: boolean; finishedNow: boolean }>({ scope, answers: null, ended: false, finishedNow: false });
  if (held.scope !== scope) setHeld({ scope, answers: null, ended: false, finishedNow: false });
  const answers = held.scope === scope ? held.answers : null;
  const ended = held.scope === scope && held.ended;
  const finishedNow = held.scope === scope && held.finishedNow;
  const publish = useCallback((next: GetStartedAnswers | null, nextEnded: boolean, nextFinishedNow: boolean) => setHeld({ scope, answers: next, ended: nextEnded, finishedNow: nextFinishedNow }), [scope]);
  const consumeFinishedNow = useCallback(() => setHeld((current) => (current.finishedNow ? { ...current, finishedNow: false } : current)), []);
  const value = useMemo<AnswersStore>(() => ({ answers, ended, finishedNow, publish, consumeFinishedNow }), [answers, ended, finishedNow, publish, consumeFinishedNow]);
  return <AnswersContext value={value}>{children}</AnswersContext>;
}

/** The finished wizard's answers, or null when unknown, skipped or never offered. Safe without a provider. */
export function useGetStartedAnswers(): GetStartedAnswers | null {
  return useContext(AnswersContext)?.answers ?? null;
}

/**
 * True once the owner finished or skipped Get started on this computer. Getting started then
 * reopens on every load until its steps are done. Safe without a provider.
 */
export function useGetStartedEnded(): boolean {
  return useContext(AnswersContext)?.ended ?? false;
}

/**
 * True only when the owner finished setup in this window just now, not when a finished setup
 * loads later or was skipped. A first app they picked then starts building. Safe without a provider.
 */
export function useGetStartedFinishedNow(): boolean {
  return useContext(AnswersContext)?.finishedNow ?? false;
}

const NOTHING_TO_CONSUME = () => {};

/**
 * Ends `useGetStartedFinishedNow` for this arrival once its one-time action has started or been
 * dropped, so a remounted reader never repeats it. Safe without a provider.
 */
export function useConsumeGetStartedFinishedNow(): () => void {
  return useContext(AnswersContext)?.consumeFinishedNow ?? NOTHING_TO_CONSUME;
}

/** Called by the gate once answers are known or setup has ended. */
export function usePublishGetStartedAnswers(answers: GetStartedAnswers | null, ended = false, finishedNow = false): void {
  const publish = useContext(AnswersContext)?.publish;
  useLayoutEffect(() => {
    if (publish && (answers || ended)) publish(answers, ended, finishedNow);
  }, [answers, ended, finishedNow, publish]);
}
