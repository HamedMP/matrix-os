import type { GetStartedAnswers } from "@matrix-os/contracts";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

interface AnswersStore {
  answers: GetStartedAnswers | null;
  publish(answers: GetStartedAnswers | null): void;
}

const AnswersContext = createContext<AnswersStore | null>(null);

/**
 * Spec 635, Section 5: shares the owner's saved answers with the rest of the desktop
 * (Getting started, the onboarding widget). Mount next to `GettingStartedVisibilityProvider`;
 * a scope change (account, computer or runtime) starts empty.
 */
export function GetStartedAnswersProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const [held, setHeld] = useState<{ scope: string; answers: GetStartedAnswers | null }>({ scope, answers: null });
  if (held.scope !== scope) setHeld({ scope, answers: null });
  const answers = held.scope === scope ? held.answers : null;
  const publish = useCallback((next: GetStartedAnswers | null) => setHeld({ scope, answers: next }), [scope]);
  const value = useMemo<AnswersStore>(() => ({ answers, publish }), [answers, publish]);
  return <AnswersContext value={value}>{children}</AnswersContext>;
}

/** The finished wizard's answers, or null when unknown, skipped or never offered. Safe without a provider. */
export function useGetStartedAnswers(): GetStartedAnswers | null {
  return useContext(AnswersContext)?.answers ?? null;
}

/** Called by the gate once answers are known. */
export function usePublishGetStartedAnswers(answers: GetStartedAnswers | null): void {
  const publish = useContext(AnswersContext)?.publish;
  useLayoutEffect(() => {
    if (publish && answers) publish(answers);
  }, [answers, publish]);
}
