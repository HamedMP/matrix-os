// Installed-app windows outlive the main Matrix window, but some bridge
// actions (open an app, open Chat, start an app task) are carried out by the
// main renderer. When it is closed, reopen it through the app's single-flight
// path and wait, bounded, until its renderer says it can take those actions.
export const MAIN_WINDOW_ACTIONS_READY_TIMEOUT_MS = 15_000;
// Bridge rate limits already cap these actions; past this, the oldest waiter fails first.
const MAX_WAITERS = 8;

export function createMainWindowActionGate(options: {
  hasMainWindow(): boolean;
  isSignedIn(): boolean;
  /** The app's single-flight create-or-focus path for the main window. */
  reopenMainWindow(): Promise<void>;
  /** Brings the main window forward (reopening it if needed) so the owner can sign in. */
  showMainWindow(): void;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? MAIN_WINDOW_ACTIONS_READY_TIMEOUT_MS;
  let ready = false;
  // Set while a window this gate reopened has not yet reported ready.
  let awaitingRenderer = false;
  let reopening: Promise<void> | null = null;
  // Insertion order is age; each waiter resolves true (ready) or false (timeout, evicted, quit).
  const waiters = new Map<symbol, (value: boolean) => void>();

  const reopen = (): Promise<void> => {
    awaitingRenderer = true;
    reopening ??= options.reopenMainWindow().finally(() => { reopening = null; });
    return reopening;
  };

  const settleAll = (value: boolean) => {
    for (const settle of [...waiters.values()]) settle(value);
  };

  const waitForRenderer = (): Promise<boolean> => {
    if (ready) return Promise.resolve(true);
    while (waiters.size >= MAX_WAITERS) {
      const oldest = waiters.values().next().value;
      if (!oldest) break;
      oldest(false);
    }
    return new Promise((resolve) => {
      const key = Symbol("waiter");
      const timer = setTimeout(() => settle(false), timeoutMs);
      const settle = (value: boolean) => {
        clearTimeout(timer);
        waiters.delete(key);
        resolve(value);
      };
      waiters.set(key, settle);
    });
  };

  return {
    /**
     * Resolves when the main renderer can take an action; rejects with the
     * caller's generic message when signed out, on reopen failure or timeout.
     */
    async ensure(failureMessage: string): Promise<void> {
      if (!options.isSignedIn()) {
        // The renderer only reports ready after sign-in: never wait for it while signed out.
        options.showMainWindow();
        throw new Error(failureMessage);
      }
      if (options.hasMainWindow() && !awaitingRenderer) return;
      if (!options.hasMainWindow() || reopening) {
        try {
          await reopen();
        } catch (error: unknown) {
          console.warn("[installed-apps] main window could not reopen:", error instanceof Error ? error.name : "UnknownError");
          throw new Error(failureMessage);
        }
      }
      if (!(await waitForRenderer()) || !options.hasMainWindow()) {
        console.warn("[installed-apps] main window was not ready for an app action");
        throw new Error(failureMessage);
      }
    },

    /** The main renderer has its app, Chat and task listeners attached and is signed in. */
    rendererReady(): void {
      ready = true;
      awaitingRenderer = false;
      settleAll(true);
    },

    isReady: (): boolean => ready,

    /** The main renderer reloaded, crashed or closed. */
    rendererReset(): void {
      ready = false;
    },

    /** Quit: fail every waiting action and clear its timer. */
    dispose(): void {
      settleAll(false);
    },
  };
}
