// Tells the main process which keys this Terminal handles itself while it has
// keyboard focus, so a Matrix shortcut on the same key (window arrangement on
// Ctrl+Shift+arrows) does not take it first (specs/653). The claim covers the
// effective bindings of the active profile and ends on blur or unmount. If a
// report is lost, main falls back to running the shortcut, and it also drops
// a window's claims when the window blurs, navigates or closes.
import { useEffect, useMemo, type RefObject } from "react";
import { terminalShortcutClaims } from "@matrix-os/contracts/keyboard-shortcuts";
import type { TerminalKeyboardPreferences } from "@matrix-os/contracts";
import { invoke } from "../../lib/operator";

function report(bindings: string[]): void {
  try {
    invoke("shortcuts:set-terminal-claims", { bindings }).catch((error: unknown) => {
      console.warn("[terminal] could not report its shortcut keys:", error);
    });
  } catch (error: unknown) {
    console.warn("[terminal] could not report its shortcut keys:", error);
  }
}

export function useTerminalShortcutClaims(
  hostRef: RefObject<HTMLElement | null>,
  options: { preferences: TerminalKeyboardPreferences; isMac: boolean; enabled: boolean },
): void {
  const { preferences, isMac, enabled } = options;
  // A string, so the effect re-runs only when the claimed keys change.
  const claimKey = useMemo(
    () => (enabled ? terminalShortcutClaims(preferences, isMac).join("\n") : ""),
    [enabled, preferences, isMac],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host || claimKey === "") return;
    const bindings = claimKey.split("\n");
    const view = host.ownerDocument.defaultView;
    let held = false;
    const sync = (focused: EventTarget | null) => {
      const want = focused instanceof Node && host.contains(focused);
      if (want === held) return;
      held = want;
      report(want ? bindings : []);
    };
    const onFocusIn = (event: FocusEvent) => sync(event.target);
    const onFocusOut = (event: FocusEvent) => sync(event.relatedTarget);
    // Main drops the claim when the window blurs; claim again on return.
    const onWindowFocus = () => sync(host.ownerDocument.activeElement);
    const onWindowBlur = () => sync(null);
    host.addEventListener("focusin", onFocusIn);
    host.addEventListener("focusout", onFocusOut);
    view?.addEventListener("focus", onWindowFocus);
    view?.addEventListener("blur", onWindowBlur);
    sync(host.ownerDocument.activeElement);
    return () => {
      host.removeEventListener("focusin", onFocusIn);
      host.removeEventListener("focusout", onFocusOut);
      view?.removeEventListener("focus", onWindowFocus);
      view?.removeEventListener("blur", onWindowBlur);
      if (held) report([]);
    };
  }, [hostRef, claimKey]);
}
