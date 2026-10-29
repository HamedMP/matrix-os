import type { OnboardingStarterTaskId } from "@matrix-os/contracts";
import { useEffect, useRef } from "react";

/**
 * Lets other surfaces (the Getting started app, spec 639) start one of the
 * widget's starter tasks in the widget. The mounted widget registers a
 * listener; the newest one handles a request. Bounded: a shell mounts one
 * widget, and stale entries are removed on unmount.
 */
type Listener = (taskId: OnboardingStarterTaskId) => void;

const MAX_LISTENERS = 4;
const listeners: Listener[] = [];

/** False when no widget is mounted, so the caller can fall back to Chat. */
export function requestOnboardingTask(taskId: OnboardingStarterTaskId): boolean {
  const listener = listeners.at(-1);
  if (!listener) return false;
  listener(taskId);
  return true;
}

export function useOnboardingTaskRequests(onTask: Listener): void {
  const latest = useRef(onTask);
  useEffect(() => {
    latest.current = onTask;
  });
  useEffect(() => {
    const listener: Listener = (taskId) => latest.current(taskId);
    listeners.push(listener);
    if (listeners.length > MAX_LISTENERS) listeners.splice(0, listeners.length - MAX_LISTENERS);
    return () => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    };
  }, []);
}
