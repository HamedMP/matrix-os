import type { BrowserWindow, Event } from "electron";

interface Options {
  drain(): Promise<void>;
  close(): Promise<void>;
  quit(): void;
  reportError(error: unknown): void;
}

type Attempt = { phase: "draining" | "drained" | "closing" };

export function createMacActivityQuit(options: Options) {
  let attempt: Attempt | undefined;
  let finished = false;

  function beforeQuit(event: Pick<Event, "preventDefault">): boolean {
    if (finished || (attempt && attempt.phase !== "draining")) return false;
    event.preventDefault();
    if (attempt) return true;

    const started: Attempt = { phase: "draining" };
    attempt = started;
    const replayQuit = () => {
      if (attempt !== started || started.phase !== "draining" || finished) return;
      started.phase = "drained";
      options.quit();
    };
    const deadline = setTimeout(replayQuit, 5_000);
    deadline.unref();
    void options.drain().catch(options.reportError).finally(() => {
      clearTimeout(deadline);
      replayQuit();
    });
    return true;
  }

  function watchWindow(window: Pick<BrowserWindow, "on" | "webContents">): void {
    let closing: Attempt | undefined;
    window.on("close", (event) => {
      closing = !event.defaultPrevented && attempt?.phase === "closing" ? attempt : undefined;
    });
    window.webContents.on("will-prevent-unload", (event) => {
      const vetoed = closing;
      closing = undefined;
      // Let other unload handlers run first. They may explicitly allow this close.
      if (vetoed) queueMicrotask(() => {
        if (attempt === vetoed && !event.defaultPrevented) attempt = undefined;
      });
    });
  }

  return {
    beforeQuit,
    watchWindow,
    isFenced: () => attempt !== undefined || finished,
    allowWindowClose(event: Pick<Event, "defaultPrevented">): void {
      if (attempt?.phase === "drained" && !event.defaultPrevented) attempt.phase = "closing";
    },
    finish(): void {
      if (finished) return;
      finished = true;
      attempt = undefined;
      void options.close().catch(options.reportError);
    },
  };
}
