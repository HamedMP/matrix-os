// Installed-app windows outlive the main Matrix window, but some bridge
// actions (open an app, open Chat, start an app task) are carried out by the
// main renderer. When it is closed, reopen it through the app's single-flight
// path and wait, bounded, until its renderer says it can take those actions.
import { z } from "zod/v4";

export const MAIN_WINDOW_ACTIONS_READY_TIMEOUT_MS = 15_000;
export const MAIN_WINDOW_ACTIONS_READY_CHANNEL = "window:native-actions-ready";
const MAX_WAITERS = 32;

export function createMainWindowActionGate(options: {
  hasMainWindow(): boolean;
  isSignedIn(): boolean;
  /** The app's single-flight create-or-focus path for the main window. */
  reopenMainWindow(): Promise<void>;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? MAIN_WINDOW_ACTIONS_READY_TIMEOUT_MS;
  let ready = false;
  // Set while a window this gate reopened has not yet reported ready.
  let awaitingRenderer = false;
  let reopening: Promise<void> | null = null;
  const waiters = new Set<() => void>();

  const reopen = (): Promise<void> => {
    awaitingRenderer = true;
    reopening ??= options.reopenMainWindow().finally(() => { reopening = null; });
    return reopening;
  };

  const waitForRenderer = (): Promise<boolean> => {
    if (ready) return Promise.resolve(true);
    if (waiters.size >= MAX_WAITERS) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (value: boolean) => {
        clearTimeout(timer);
        waiters.delete(onReady);
        resolve(value);
      };
      const onReady = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      waiters.add(onReady);
    });
  };

  return {
    /**
     * Resolves when the main renderer can take an action; rejects with the
     * caller's generic message when signed out, on reopen failure or timeout.
     */
    async ensure(failureMessage: string): Promise<void> {
      if (!options.isSignedIn()) throw new Error(failureMessage);
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
      for (const waiter of [...waiters]) waiter();
    },

    /** The main renderer reloaded, crashed or closed. */
    rendererReset(): void {
      ready = false;
    },
  };
}

const ReadyRequestSchema = z.strictObject({});

export function registerMainWindowActionsReadyIpc(ipc: {
  handle(channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>): void;
}, options: { isMainWindowSender(event: unknown): boolean; ready(): void }): void {
  ipc.handle(MAIN_WINDOW_ACTIONS_READY_CHANNEL, async (event, payload) => {
    if (!ReadyRequestSchema.safeParse(payload ?? {}).success || !options.isMainWindowSender(event)) {
      throw new Error("invalid request");
    }
    options.ready();
    return { ok: true };
  });
}
