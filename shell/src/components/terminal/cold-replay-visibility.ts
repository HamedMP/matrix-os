import type { Terminal } from "@xterm/xterm";

export const COLD_REPLAY_TIMEOUT_MS = 10_000;

type VisibilityTerminal = Pick<Terminal, "reset" | "write"> & {
  element?: HTMLElement | null;
};

interface ColdReplayVisibilityOptions {
  terminal: VisibilityTerminal;
  coldReplay: boolean;
  isCurrent: () => boolean;
  onVisible: () => void;
  onTimeout: () => void;
}

export interface ColdReplayVisibility {
  revealAfterWrites: () => void;
  dispose: () => void;
}

export function createColdReplayVisibility({
  terminal,
  coldReplay,
  isCurrent,
  onVisible,
  onTimeout,
}: ColdReplayVisibilityOptions): ColdReplayVisibility {
  let disposed = false;
  let revealRequested = false;
  let revealFrame: number | null = null;
  let timeout: number | null = null;

  const setVisible = (visible: boolean) => {
    if (terminal.element) {
      terminal.element.style.visibility = visible ? "visible" : "hidden";
    }
  };
  const clearRevealFrame = () => {
    if (revealFrame !== null) {
      cancelAnimationFrame(revealFrame);
      revealFrame = null;
    }
  };
  const clearTimeoutFallback = () => {
    if (timeout !== null) {
      window.clearTimeout(timeout);
      timeout = null;
    }
  };
  const dispose = () => {
    disposed = true;
    clearRevealFrame();
    clearTimeoutFallback();
  };

  setVisible(!coldReplay);
  if (coldReplay) {
    timeout = window.setTimeout(() => {
      timeout = null;
      if (disposed || !isCurrent()) {
        return;
      }
      disposed = true;
      clearRevealFrame();
      onTimeout();
    }, COLD_REPLAY_TIMEOUT_MS);
  }

  return {
    revealAfterWrites: () => {
      if (!coldReplay || disposed || revealRequested) {
        return;
      }
      revealRequested = true;
      terminal.write("", () => {
        if (disposed || !isCurrent()) {
          return;
        }
        clearRevealFrame();
        revealFrame = requestAnimationFrame(() => {
          revealFrame = null;
          if (disposed || !isCurrent()) {
            return;
          }
          clearTimeoutFallback();
          setVisible(true);
          onVisible();
        });
      });
    },
    dispose,
  };
}
