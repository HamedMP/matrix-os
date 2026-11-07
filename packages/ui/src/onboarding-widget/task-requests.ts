import { ONBOARDING_TASKS, type OnboardingStarterTaskId, type OnboardingWidgetState } from "@matrix-os/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Connects the corner onboarding widget with the Getting started app (spec 639).
 * The widget runs starter tasks; the app hands them over here, and mirrors what
 * the widget is doing from the status it publishes. Bounded: a shell mounts one
 * widget, the newest one wins, and stale entries are removed on unmount.
 */
type Listener = { task(taskId: OnboardingStarterTaskId): void; show(): void };

const MAX_LISTENERS = 4;
const listeners: Listener[] = [];

/** False when no widget is mounted, so the caller can fall back to Chat. */
export function requestOnboardingTask(taskId: OnboardingStarterTaskId): boolean {
  const listener = listeners.at(-1);
  if (!listener) return false;
  listener.task(taskId);
  return true;
}

/** Brings a minimized widget back to the corner; false when no widget is mounted. */
export function requestOnboardingWidgetShow(): boolean {
  const listener = listeners.at(-1);
  if (!listener) return false;
  listener.show();
  return true;
}

export function useOnboardingTaskRequests(onTask: Listener["task"], onShow: Listener["show"]): void {
  const latest = useRef({ task: onTask, show: onShow });
  useEffect(() => {
    latest.current = { task: onTask, show: onShow };
  });
  useEffect(() => {
    const listener: Listener = {
      task: (taskId) => latest.current.task(taskId),
      show: () => latest.current.show(),
    };
    listeners.push(listener);
    if (listeners.length > MAX_LISTENERS) listeners.splice(0, listeners.length - MAX_LISTENERS);
    return () => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    };
  }, []);
}

export type OnboardingWidgetActivity =
  | { kind: "choosing" }
  | { kind: "setup" | "running" | "done" | "failed"; title: string };

/** `open`: the widget sits in the corner rather than minimized to its bubble. */
export interface OnboardingWidgetStatus {
  open: boolean;
  activity: OnboardingWidgetActivity;
}

const TITLE_MAX_CHARS = 80;

function starterLabel(taskId: OnboardingStarterTaskId): string {
  return ONBOARDING_TASKS.find((task) => task.id === taskId)?.label ?? "Your first task";
}

function shortTitle(text: string): string {
  const title = text.trim() || "Your first task";
  return title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS - 1)}…` : title;
}

/** What the widget is doing, in the terms the Getting started app shows. */
export function onboardingWidgetStatus(state: OnboardingWidgetState): OnboardingWidgetStatus {
  const open = state.size === "corner";
  const screen = state.screen;
  switch (screen.kind) {
    case "tasks":
    case "apps":
      return { open, activity: { kind: "choosing" } };
    case "question":
    case "connect":
      return { open, activity: { kind: "setup", title: starterLabel(screen.taskId) } };
    case "repo":
      return { open, activity: { kind: "setup", title: starterLabel("work-on-code") } };
    case "run": {
      const title = shortTitle(screen.title ?? (screen.taskId === "custom" ? screen.answer : starterLabel(screen.taskId)));
      const kind = screen.phase === "done" ? "done" : screen.phase === "failed" ? "failed" : "running";
      return { open, activity: { kind, title } };
    }
  }
}

let current: { owner: object; status: OnboardingWidgetStatus } | null = null;
// One per mounted reader (the app's hero on each surface); capped, oldest dropped first.
const MAX_SUBSCRIBERS = 32;
const subscribers: Array<() => void> = [];

function notify(): void {
  for (const subscriber of [...subscribers]) subscriber();
}

function subscribe(subscriber: () => void): () => void {
  subscribers.push(subscriber);
  if (subscribers.length > MAX_SUBSCRIBERS) subscribers.splice(0, subscribers.length - MAX_SUBSCRIBERS);
  return () => {
    const index = subscribers.indexOf(subscriber);
    if (index >= 0) subscribers.splice(index, 1);
  };
}

function snapshot(): OnboardingWidgetStatus | null {
  return current?.status ?? null;
}

/** The mounted widget's status, or null when no widget is mounted. */
export function useOnboardingWidgetStatus(): OnboardingWidgetStatus | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** The widget publishes its status; it clears on unmount unless a newer widget took over. */
export function usePublishOnboardingWidgetStatus(status: OnboardingWidgetStatus): void {
  const owner = useRef<object>({});
  const { open, activity } = status;
  const kind = activity.kind;
  const title = "title" in activity ? activity.title : null;
  useEffect(() => {
    const next: OnboardingWidgetActivity = kind === "choosing" || title === null ? { kind: "choosing" } : { kind, title };
    current = { owner: owner.current, status: { open, activity: next } };
    notify();
  }, [open, kind, title]);
  useEffect(() => () => {
    if (current?.owner !== owner.current) return;
    current = null;
    notify();
  }, []);
}
