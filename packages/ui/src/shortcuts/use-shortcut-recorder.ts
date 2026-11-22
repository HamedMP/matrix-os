import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  bindingFromKeyEvent,
  heldModifiers,
  type ShortcutPlatform,
} from "@matrix-os/contracts/keyboard-shortcuts";

export interface ShortcutRecorderOptions<T> {
  platform: ShortcutPlatform;
  /** Called with the first complete binding pressed while recording `target`. */
  onCapture(target: T, binding: string): void;
  onRecordingChange?(recording: boolean): void;
}

export interface ShortcutRecorder<T> {
  /** What is being recorded, or null when idle. */
  target: T | null;
  /** Modifiers currently held, in binding order (e.g. ["Cmd", "Shift"]). */
  held: string[];
  /** Starts recording; focus returns to `returnFocus` when recording ends by key. */
  start(target: T, returnFocus?: HTMLElement | null): void;
  /** Stops recording without capturing (Escape, blur, toggle). */
  cancel(options?: { restoreFocus?: boolean }): void;
}

/**
 * Records one key combination. While recording, every key press is swallowed
 * at the window capture phase so app and menu handlers never see it, and Tab
 * is recorded instead of moving focus.
 */
export function useShortcutRecorder<T>({
  platform,
  onCapture,
  onRecordingChange,
}: ShortcutRecorderOptions<T>): ShortcutRecorder<T> {
  const [target, setTarget] = useState<T | null>(null);
  const [held, setHeld] = useState<string[]>([]);
  // Mirrors `target` so exit paths stay idempotent within one event turn.
  const activeRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Plain functions on purpose: they run from event handlers, and an effect
  // event (useEffectEvent) may only be called from inside effects.
  const finish = (restoreFocus: boolean) => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setTarget(null);
    setHeld([]);
    onRecordingChange?.(false);
    const focusTarget = returnFocusRef.current;
    returnFocusRef.current = null;
    if (restoreFocus && focusTarget?.isConnected) focusTarget.focus();
  };

  const start = (next: T, returnFocus: HTMLElement | null = null) => {
    const wasActive = activeRef.current;
    activeRef.current = true;
    returnFocusRef.current = returnFocus;
    setTarget(() => next);
    setHeld([]);
    if (!wasActive) onRecordingChange?.(true);
  };

  const cancel = (options?: { restoreFocus?: boolean }) => {
    finish(options?.restoreFocus ?? false);
  };

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || target === null) return;
    if (event.key === "Escape") {
      finish(true);
      return;
    }
    const binding = bindingFromKeyEvent(event, platform);
    if (binding === null) {
      setHeld(heldModifiers(event, platform));
      return;
    }
    const captured = target;
    finish(true);
    onCapture(captured, binding);
  });

  const handleKeyUp = useEffectEvent((event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setHeld(heldModifiers(event, platform));
  });

  const recording = target !== null;
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => handleKeyDown(event);
    const onKeyUp = (event: KeyboardEvent) => handleKeyUp(event);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [recording]);

  const reportStoppedOnUnmount = useEffectEvent(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    onRecordingChange?.(false);
  });

  // Unmounting mid-recording is an exit path too.
  useEffect(() => () => reportStoppedOnUnmount(), []);

  return { target, held, start, cancel };
}
