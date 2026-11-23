// The keys a focused terminal in the Terminal window hands to the window's
// menu (spec 2706): its registry actions' bindings as the person set them in
// Shortcuts settings, plus the fixed digits. Until the bindings arrive, and if
// they cannot be read, the defaults apply.
import { useCallback, useEffect, useMemo, useState } from "react";
import { resolveShortcuts, type EffectiveShortcuts } from "@matrix-os/contracts/keyboard-shortcuts";
import { invoke, onEvent } from "../../lib/operator";
import { isTerminalWindowKey, terminalWindowKeys } from "../../../../shared/terminal-window";

const isMac = typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");

export function useTerminalWindowKeys(): (event: KeyboardEvent) => boolean {
  const [effective, setEffective] = useState<EffectiveShortcuts>(() => resolveShortcuts(null, isMac ? "mac" : "other"));
  useEffect(() => {
    let live = true;
    invoke("shortcuts:get", {})
      .then((snapshot) => { if (live && snapshot?.effective) setEffective(snapshot.effective as EffectiveShortcuts); })
      .catch((error: unknown) => {
        console.warn("[terminal-window] shortcut keys unavailable, using defaults:", error instanceof Error ? error.name : "UnknownError");
      });
    const stop = onEvent("shortcuts:changed", (snapshot) => { if (snapshot?.effective) setEffective(snapshot.effective as EffectiveShortcuts); });
    return () => { live = false; stop(); };
  }, []);
  const keys = useMemo(() => terminalWindowKeys(effective, isMac), [effective]);
  return useCallback((event: KeyboardEvent) => isTerminalWindowKey(keys, event, isMac), [keys]);
}
