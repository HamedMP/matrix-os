import { useSyncExternalStore } from "react";

import { successHaptic, warningHaptic } from "@/lib/haptics";

/** `progress` is for something still happening, such as a computer waking. */
export type ToastTone = "success" | "error" | "progress";

/** A short note at the top of the screen that goes away by itself, unless it is persistent. */
export interface Toast {
  /** Names this toast, so a timer started for it cannot hide a later one. */
  id: number;
  message: string;
  tone: ToastTone;
  /** Stays until dismissed with `dismissToast`; a temporary toast shown over it hides it only until that toast ends. */
  persistent: boolean;
}

export interface ShowToastOptions {
  persistent?: boolean;
}

/** How long a toast stays, fading in and out included. */
export const TOAST_DURATION_MS = 2200;

// One toast at a time: a later one replaces the one on screen.
let current: Toast | null = null;
// The persistent toast still in force, shown again once a temporary toast that replaced it ends.
let pinned: Toast | null = null;
let lastId = 0;
// Ends the current toast. Kept here rather than in the host, so a toast ends
// on time however the host re-renders.
let expiry: ReturnType<typeof setTimeout> | null = null;
// One entry per mounted `useToast`, removed when it unmounts.
let listeners: readonly (() => void)[] = [];

function publish(next: Toast | null) {
  if (expiry) clearTimeout(expiry);
  expiry = next && !next.persistent ? setTimeout(() => dismissToast(next.id), TOAST_DURATION_MS) : null;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((existing) => existing !== listener);
    // With no host left to draw it, the toast and its timer go too.
    if (listeners.length === 0) {
      pinned = null;
      publish(null);
    }
  };
}

const currentToast = () => current;

/**
 * Shows `message` in the toast host mounted at the root of the app, with the
 * haptic that matches its tone (none for `progress`). Without a host, nothing
 * is shown or played. Returns the toast's id, or null when nothing was shown.
 */
export function showToast(message: string, tone: ToastTone = "success", options: ShowToastOptions = {}): number | null {
  if (listeners.length === 0) return null;
  lastId += 1;
  const next: Toast = { id: lastId, message, tone, persistent: options.persistent === true };
  if (next.persistent) pinned = next;
  publish(next);
  if (tone === "success") successHaptic();
  else if (tone === "error") warningHaptic();
  return lastId;
}

/**
 * Hides the toast named `id`, unless a later one has replaced it. When a
 * temporary toast ends, a persistent toast it covered comes back.
 */
export function dismissToast(id: number): void {
  if (pinned?.id === id) pinned = null;
  if (current?.id === id) publish(pinned);
}

/** The toast on screen, if any. */
export function useToast(): Toast | null {
  return useSyncExternalStore(subscribe, currentToast, currentToast);
}
