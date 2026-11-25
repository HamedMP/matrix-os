// Owns the keyboard shortcut overrides in the main process (specs/653): loads
// them from the local store, validates and persists changes, and tells the
// menu and the windows when they change.
import {
  EMPTY_SHORTCUT_OVERRIDES,
  MAX_BINDINGS_PER_ACTION,
  SHORTCUT_ACTIONS,
  shortcutScope,
  ShortcutOverridesSchema,
  resolveShortcuts,
  validateBinding,
  validateOverrides,
  type ShortcutOverrides,
  type ShortcutPlatform,
} from "@matrix-os/contracts/keyboard-shortcuts";
import type { LocalStore } from "../persistence/local-store";
import type { ShortcutSnapshot } from "../../shared/shortcuts-ipc";
import { createTerminalClaims } from "./terminal-claims";

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
  /** True from a recording start until its matching stop or the guard time. */
  isRecording(): boolean;
  /** The keys the focused Terminal in `target` handles itself; [] ends the claim. */
  setTerminalClaims(target: object, bindings: readonly string[]): void;
  clearTerminalClaims(target: object): void;
  isTerminalClaimed(target: object, binding: string): boolean;
  dispose(): void;
}

export function toShortcutPlatform(platform: NodeJS.Platform): ShortcutPlatform {
  return platform === "darwin" ? "mac" : "other";
}

/**
 * Keeps what is still valid in stored overrides, for example after a build
 * reserves a key the owner had bound. Actions are walked in registry order, so
 * a binding held by two actions stays with the earlier one. An action whose
 * list empties only because bindings were dropped falls back to its defaults;
 * a list stored empty stays unbound.
 */
export function sanitizeOverrides(overrides: ShortcutOverrides, platform: ShortcutPlatform): ShortcutOverrides {
  const kept: Record<string, string[]> = {};
  const claimed = new Set<string>();
  for (const { id } of SHORTCUT_ACTIONS) {
    if (!Object.hasOwn(overrides.overrides, id)) continue;
    const stored = overrides.overrides[id] ?? [];
    const bindings: string[] = [];
    for (const binding of stored) {
      if (bindings.length >= MAX_BINDINGS_PER_ACTION) break;
      // Unique within its scope: the Terminal window's actions may reuse main-window keys.
      const scoped = `${shortcutScope(id)} ${binding}`;
      if (claimed.has(scoped) || !validateBinding(binding, platform).ok) continue;
      claimed.add(scoped);
      bindings.push(binding);
    }
    if (bindings.length > 0 || stored.length === 0) kept[id] = bindings;
  }
  return { version: 1, overrides: kept };
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
  const terminalClaims = createTerminalClaims(platform);

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
      let stored: unknown;
      try {
        stored = await deps.store.get("keyboardShortcuts");
      } catch (error: unknown) {
        console.warn("[shortcuts] could not read overrides, using defaults:", error instanceof Error ? error.message : String(error));
        return;
      }
      if (stored === null) return;
      const parsed = ShortcutOverridesSchema.safeParse(stored);
      if (!parsed.success) {
        console.warn("[shortcuts] stored overrides are unreadable, using defaults");
        return;
      }
      if (validateOverrides(parsed.data, platform)) {
        current = parsed.data;
        return;
      }
      // Not written back: a later build may accept what this one drops.
      console.warn("[shortcuts] dropped stored shortcuts that are no longer valid");
      current = sanitizeOverrides(parsed.data, platform);
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

    isRecording() {
      return recordingTarget !== null;
    },

    setTerminalClaims: terminalClaims.set,
    clearTerminalClaims: terminalClaims.clear,
    isTerminalClaimed: terminalClaims.has,

    dispose() {
      stopTimer();
      recordingTarget = null;
      terminalClaims.clearAll();
    },
  };
}
