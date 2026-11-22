// Owns the keyboard shortcut overrides in the main process (specs/653): loads
// them from the local store, validates and persists changes, and tells the
// menu and the windows when they change.
import {
  EMPTY_SHORTCUT_OVERRIDES,
  resolveShortcuts,
  validateOverrides,
  type ShortcutOverrides,
  type ShortcutPlatform,
} from "@matrix-os/contracts/keyboard-shortcuts";
import type { LocalStore } from "../persistence/local-store";
import type { ShortcutSnapshot } from "../../shared/shortcuts-ipc";

/** Menu shortcuts come back on by themselves if the recorder never says it stopped. */
export const RECORDING_GUARD_MS = 30_000;
// The menu and the IPC broadcaster subscribe; more than this is a leak.
const MAX_LISTENERS = 16;

export interface RecordingTarget {
  setIgnoreMenuShortcuts(ignore: boolean): void;
  isDestroyed(): boolean;
}

export interface ShortcutService {
  /** Never throws: missing, unreadable or invalid overrides fall back to the defaults. */
  load(): Promise<void>;
  snapshot(): ShortcutSnapshot;
  /** Rejects with "invalid request" when the overrides are invalid or cannot be saved. */
  set(overrides: ShortcutOverrides): Promise<ShortcutSnapshot>;
  onChange(listener: (snapshot: ShortcutSnapshot) => void): () => void;
  setRecording(target: RecordingTarget, recording: boolean): void;
  dispose(): void;
}

export function toShortcutPlatform(platform: NodeJS.Platform): ShortcutPlatform {
  return platform === "darwin" ? "mac" : "other";
}

export function createShortcutService(deps: {
  store: Pick<LocalStore, "get" | "set">;
  platform: NodeJS.Platform;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): ShortcutService {
  const platform = toShortcutPlatform(deps.platform);
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const listeners = new Set<(snapshot: ShortcutSnapshot) => void>();
  let current: ShortcutOverrides = EMPTY_SHORTCUT_OVERRIDES;
  let setChain: Promise<unknown> = Promise.resolve();
  let recordingTarget: RecordingTarget | null = null;
  let recordingTimer: ReturnType<typeof setTimeout> | null = null;

  function snapshot(): ShortcutSnapshot {
    return {
      platform,
      overrides: { version: 1, overrides: structuredClone(current.overrides) },
      effective: resolveShortcuts(current, platform),
    };
  }

  function notify(): void {
    const next = snapshot();
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (error: unknown) {
        console.warn("[shortcuts] change listener failed:", error instanceof Error ? error.message : String(error));
      }
    }
  }

  async function apply(overrides: ShortcutOverrides): Promise<ShortcutSnapshot> {
    const next: ShortcutOverrides = { version: 1, overrides: structuredClone(overrides.overrides) };
    try {
      await deps.store.set("keyboardShortcuts", next);
    } catch (error: unknown) {
      console.warn("[shortcuts] could not save overrides:", error instanceof Error ? error.message : String(error));
      throw new Error("invalid request");
    }
    current = next;
    notify();
    return snapshot();
  }

  function setIgnore(target: RecordingTarget, ignore: boolean): void {
    if (target.isDestroyed()) return;
    target.setIgnoreMenuShortcuts(ignore);
  }

  function stopTimer(): void {
    if (recordingTimer === null) return;
    clearTimer(recordingTimer);
    recordingTimer = null;
  }

  return {
    async load() {
      let stored: ShortcutOverrides | null;
      try {
        stored = await deps.store.get("keyboardShortcuts");
      } catch (error: unknown) {
        console.warn("[shortcuts] could not read overrides, using defaults:", error instanceof Error ? error.message : String(error));
        return;
      }
      if (stored === null) return;
      if (!validateOverrides(stored, platform)) {
        console.warn("[shortcuts] stored overrides are invalid, using defaults");
        return;
      }
      current = stored;
    },

    snapshot,

    set(overrides) {
      if (!validateOverrides(overrides, platform)) {
        return Promise.reject(new Error("invalid request"));
      }
      const task = setChain.then(() => apply(overrides));
      // A failed set must not stall the ones queued behind it; its caller still
      // sees the error, and apply() has already logged why it failed.
      setChain = task.catch((error: unknown) => {
        if (!(error instanceof Error)) console.warn("[shortcuts] unexpected set failure");
      });
      return task;
    },

    onChange(listener) {
      if (listeners.size >= MAX_LISTENERS) throw new Error("too many shortcut listeners");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setRecording(target, recording) {
      if (!recording) {
        setIgnore(target, false);
        // Another window's stop (blur, navigation) must not cancel this one's guard.
        if (recordingTarget === target) {
          stopTimer();
          recordingTarget = null;
        }
        return;
      }
      stopTimer();
      if (recordingTarget !== null && recordingTarget !== target) setIgnore(recordingTarget, false);
      recordingTarget = target;
      setIgnore(target, true);
      recordingTimer = setTimer(() => {
        recordingTimer = null;
        recordingTarget = null;
        setIgnore(target, false);
      }, RECORDING_GUARD_MS);
    },

    dispose() {
      stopTimer();
      recordingTarget = null;
    },
  };
}
