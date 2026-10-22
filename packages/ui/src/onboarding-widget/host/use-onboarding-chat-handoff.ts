import type { OnboardingWidgetState } from "@matrix-os/contracts";
import { useCallback, useEffect, useRef } from "react";

/**
 * Opens the task's named chat in Chats. The widget stays up while the run works
 * and when the result arrives; only the result button calls this.
 * Electron Desktop, Web Desktop, and Web Canvas share this caller.
 */
export function useOnboardingChatHandoff(state: OnboardingWidgetState, handOff: () => void): () => void {
  const stateRef = useRef(state);
  const handOffRef = useRef(handOff);
  useEffect(() => {
    stateRef.current = state;
    handOffRef.current = handOff;
  });

  return useCallback(() => {
    if (stateRef.current.screen.kind !== "run") return;
    handOffRef.current();
  }, []);
}
