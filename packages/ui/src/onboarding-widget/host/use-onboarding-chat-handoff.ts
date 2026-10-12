import type { OnboardingWidgetState } from "@matrix-os/contracts";
import { useEffect, useRef } from "react";

/** Calls `handOff` once for each run a chat accepts, so the work continues in the main Chat. */
export function useOnboardingChatHandoff(state: OnboardingWidgetState, handOff: () => void): void {
  const runId = state.screen.kind === "run" && state.screen.phase === "running" ? state.screen.runId ?? null : null;
  const handedOff = useRef<string | null>(null);
  const handOffRef = useRef(handOff);
  useEffect(() => {
    handOffRef.current = handOff;
  });

  useEffect(() => {
    if (!runId || handedOff.current === runId) return;
    handedOff.current = runId;
    handOffRef.current();
  }, [runId]);
}
