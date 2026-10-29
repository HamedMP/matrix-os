/**
 * One Getting started app state per shell (spec 639): reads task status and
 * points, awards tasks that became done, and raises a toast for tasks that
 * turned done while the owner was here. Mounted once at the desktop root so
 * toasts fire whether or not the app window is open.
 */
import {
  GETTING_STARTED_APP_AWARDABLE_TASK_IDS,
  deriveGettingStartedAppTasks,
  type GettingStartedAppAwardableTaskId,
  type GettingStartedAppAwardResponse,
  type GettingStartedAppProgress,
  type GettingStartedAppTask,
  type GettingStartedAppTaskId,
  type GettingStartedResults,
} from "@matrix-os/contracts";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { gettingStartedAppToastText } from "./actions.js";

export interface GettingStartedAppPort {
  loadResults(signal: AbortSignal): Promise<GettingStartedResults>;
  /** Null when this computer's gateway predates the app (404). */
  loadProgress(signal: AbortSignal): Promise<GettingStartedAppProgress | null>;
  award(taskId: GettingStartedAppAwardableTaskId, silent: boolean): Promise<GettingStartedAppAwardResponse>;
  claimAutoOpen(): Promise<boolean>;
}

export type GettingStartedAppPoints = { kind: "loading" } | { kind: "unavailable" } | { kind: "ready"; total: number };

export interface GettingStartedAppState {
  /** False until the first read, and on computers whose gateway predates the app. */
  enabled: boolean;
  loaded: boolean;
  tasks: GettingStartedAppTask[];
  doneCount: number;
  points: GettingStartedAppPoints;
  /** Opens the app window; null when the surface did not provide it. */
  open: (() => void) | null;
}

export const GETTING_STARTED_APP_REFRESH_MS = 15_000;

const AWARDABLE: ReadonlySet<GettingStartedAppTaskId> = new Set(GETTING_STARTED_APP_AWARDABLE_TASK_IDS);
const Context = createContext<GettingStartedAppState | null>(null);

function warn(message: string, error: unknown): void {
  console.warn(`[getting-started-app] ${message}:`, error instanceof Error ? error.name : typeof error);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function GettingStartedAppProvider({
  port,
  children,
  onToast,
  autoOpenEligible = false,
  onAutoOpen,
  onOpen,
  refreshMs = GETTING_STARTED_APP_REFRESH_MS,
}: {
  /**
   * Null while the shell has no signed-in computer; nothing is read. Key the
   * provider by computer so switching computers starts from a clean state.
   */
  port: GettingStartedAppPort | null;
  children?: ReactNode;
  onToast?(text: string): void;
  /** True right after the owner finishes the Get started wizard on this computer. */
  autoOpenEligible?: boolean;
  onAutoOpen?(): void;
  /** Opens or focuses the app window, for the Help popover summary. */
  onOpen?(): void;
  refreshMs?: number;
}) {
  const [enabled, setEnabled] = useState(false);
  const [results, setResults] = useState<GettingStartedResults | null>(null);
  const [points, setPoints] = useState<GettingStartedAppPoints>({ kind: "loading" });
  // Last status seen per task this session (at most 10 entries); a task seen
  // incomplete that turns complete gets a toast, one complete on first sight does not.
  const seen = useRef(new Map<GettingStartedAppTaskId, GettingStartedAppTask["status"]>());
  const awarded = useRef(new Set<GettingStartedAppTaskId>());
  const pending = useRef(new Set<GettingStartedAppTaskId>());
  // "done" once the server answered the claim; a failed request retries on the next refresh.
  const autoOpen = useRef<"idle" | "pending" | "done">("idle");
  const autoOpenEligibleRef = useRef(autoOpenEligible);
  const callbacks = useRef({ onToast, onAutoOpen });
  useEffect(() => {
    callbacks.current = { onToast, onAutoOpen };
    autoOpenEligibleRef.current = autoOpenEligible;
  });

  const progressKnown = useRef(false);

  // Awards only ever add points, so a late or out-of-order response never lowers the badge.
  const showTotal = useCallback((total: number) => {
    setPoints((current) => (current.kind === "ready" && current.total >= total ? current : { kind: "ready", total }));
  }, []);

  const claimAutoOpen = useCallback(() => {
    if (!port || !autoOpenEligibleRef.current || autoOpen.current !== "idle") return;
    autoOpen.current = "pending";
    void port.claimAutoOpen().then((open) => {
      autoOpen.current = "done";
      if (open) callbacks.current.onAutoOpen?.();
    }).catch((error: unknown) => {
      autoOpen.current = "idle";
      warn("auto-open unavailable", error);
    });
  }, [port]);

  const tasks = useMemo(() => (results ? deriveGettingStartedAppTasks(results) : []), [results]);

  // Award tasks that are done but not yet recorded. Only once points have
  // loaded, so the recorded set is known and nothing is claimed twice from here.
  const awardDone = useCallback((current: readonly GettingStartedAppTask[]) => {
    if (!port) return;
    for (const task of current) {
      const previous = seen.current.get(task.id);
      seen.current.set(task.id, task.status);
      if (task.status !== "complete" || !AWARDABLE.has(task.id)) continue;
      if (awarded.current.has(task.id) || pending.current.has(task.id)) continue;
      const taskId = task.id as GettingStartedAppAwardableTaskId;
      const silent = previous !== "incomplete";
      pending.current.add(taskId);
      void port.award(taskId, silent).then((response) => {
        awarded.current.add(taskId);
        showTotal(response.total);
        if (response.awarded && !silent) callbacks.current.onToast?.(gettingStartedAppToastText(taskId, response.points));
      }).catch((error: unknown) => {
        // Keep the toast decision for the retry on the next refresh.
        if (!silent) seen.current.set(taskId, "incomplete");
        warn("award failed", error);
      }).finally(() => {
        pending.current.delete(taskId);
      });
    }
  }, [port, showTotal]);

  const refresh = useCallback(async (signal: AbortSignal) => {
    if (!port) return;
    let progress: GettingStartedAppProgress | null | undefined;
    try {
      progress = await port.loadProgress(signal);
    } catch (error: unknown) {
      if (isAbort(error)) return;
      warn("points unavailable", error);
      progress = undefined;
    }
    if (signal.aborted) return;
    if (progress === null) {
      setEnabled(false);
      return;
    }
    setEnabled(true);
    claimAutoOpen();
    if (progress) {
      progressKnown.current = true;
      for (const award of progress.awards) awarded.current.add(award.taskId);
      showTotal(progress.total);
    } else {
      setPoints((current) => (current.kind === "ready" ? current : { kind: "unavailable" }));
    }
    try {
      const next = await port.loadResults(signal);
      if (signal.aborted) return;
      setResults(next);
      if (progressKnown.current) awardDone(deriveGettingStartedAppTasks(next));
    } catch (error: unknown) {
      if (!isAbort(error)) warn("status unavailable", error);
    }
  }, [awardDone, claimAutoOpen, port, showTotal]);

  useEffect(() => {
    if (!port) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh(controller.signal);
    }, refreshMs);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [port, refresh, refreshMs]);

  // Eligibility can arrive after the first read (the wizard ends while the desktop is open).
  useEffect(() => {
    if (enabled && autoOpenEligible) claimAutoOpen();
  }, [enabled, autoOpenEligible, claimAutoOpen]);

  const value = useMemo<GettingStartedAppState>(() => ({
    enabled,
    loaded: results !== null,
    tasks,
    doneCount: tasks.filter((task) => task.status === "complete").length,
    points,
    open: onOpen ?? null,
  }), [enabled, results, tasks, points, onOpen]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Null outside a provider. */
export function useGettingStartedApp(): GettingStartedAppState | null {
  return useContext(Context);
}
