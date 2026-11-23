/**
 * Saving before an app window goes away.
 *
 * An app runs in an iframe the shell may remove at any time, and the bridge
 * cancels requests still in flight when it is torn down. So the app saves as
 * early as it can: when its window loses focus (a click on the shell's close
 * button takes the focus first), when it is hidden, and once more when the
 * page is hidden for good. While there is unsaved work, leaving the page
 * through the browser (closing the tab, reloading) asks first.
 */

export interface LeaveGuard {
  /** Saves what can be saved now. It may start asynchronous work; it must not throw. */
  flush(): void;
  /** True while there is work that is not saved. */
  dirty(): boolean;
  log?: (message: string, error: unknown) => void;
}

/** Listens on `target` (a window) until the returned function is called. */
export function watchLeave(target: Window, guard: LeaveGuard): () => void {
  const save = (): void => {
    try {
      guard.flush();
    } catch (error: unknown) {
      guard.log?.("saving before leaving failed", error);
    }
  };
  const onVisibility = (): void => {
    if (target.document.visibilityState === "hidden") save();
  };
  const onBeforeUnload = (event: BeforeUnloadEvent | Event): void => {
    if (!guard.dirty()) return;
    event.preventDefault();
    // Older browsers ask only when a return value is set.
    (event as { returnValue?: unknown }).returnValue = "";
  };
  target.addEventListener("blur", save);
  target.addEventListener("pagehide", save);
  target.document.addEventListener("visibilitychange", onVisibility);
  target.addEventListener("beforeunload", onBeforeUnload);
  return () => {
    target.removeEventListener("blur", save);
    target.removeEventListener("pagehide", save);
    target.document.removeEventListener("visibilitychange", onVisibility);
    target.removeEventListener("beforeunload", onBeforeUnload);
  };
}
