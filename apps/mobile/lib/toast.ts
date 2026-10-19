import { useSyncExternalStore } from "react";

export type ToastTone = "success" | "error";

/** A short note at the top of the screen that goes away by itself. */
export interface Toast {
  /** Names this toast, so a timer started for it cannot hide a later one. */
  id: number;
  message: string;
  tone: ToastTone;
}

/** How long a toast stays, fading in and out included. */
export const TOAST_DURATION_MS = 2200;

// One toast at a time: a later one replaces the one on screen.
let current: Toast | null = null;
let lastId = 0;
// Ends the current toast. Kept here rather than in the host, so a toast ends
// on time however the host re-renders.
let expiry: ReturnType<typeof setTimeout> | null = null;
// One entry per mounted `useToast`, removed when it unmounts.
let listeners: readonly (() => void)[] = [];

function publish(next: Toast | null) {
  if (expiry) clearTimeout(expiry);
  expiry = next ? setTimeout(() => dismissToast(next.id), TOAST_DURATION_MS) : null;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((existing) => existing !== listener);
    // With no host left to draw it, the toast and its timer go too.
    if (listeners.length === 0) publish(null);
  };
}

const currentToast = () => current;

/** Shows `message` in the toast host mounted at the root of the app. Without a host, nothing is shown. */
export function showToast(message: string, tone: ToastTone = "success"): void {
  if (listeners.length === 0) return;
  lastId += 1;
  publish({ id: lastId, message, tone });
}

/** Hides the toast named `id`, unless a later one has replaced it. */
export function dismissToast(id: number): void {
  if (current?.id === id) publish(null);
}

/** The toast on screen, if any. */
export function useToast(): Toast | null {
  return useSyncExternalStore(subscribe, currentToast, currentToast);
}
