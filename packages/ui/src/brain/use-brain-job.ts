"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { brainJobsUnavailable, brainShellError } from "./brain-client.js";
import {
  BRAIN_JOB_CODE_COPY, type BrainJobStartInput, type BrainJobStatus, type BrainJobView, type BrainShellClient,
  type BrainShellErrorState,
} from "./brain-types.js";

/** The first poll waits 1 s; each later one waits twice as long, up to 10 s. */
export const BRAIN_JOB_POLL_FIRST_MS = 1_000;
export const BRAIN_JOB_POLL_MAX_MS = 10_000;
/** About 15 minutes of polling; then the view stops and offers "Check again". */
export const BRAIN_JOB_MAX_POLLS = 90;
/** Polls that may fail in a row (offline, too slow, brain off) before the view stops. */
export const BRAIN_JOB_MAX_FAILURES = 3;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const STATUSES: readonly BrainJobStatus[] = ["queued", "running", "succeeded", "failed", "cancelled"];
const STEPS_MAX = 1_000_000;
const NEXT_ACTION_MAX_CHARS = 64;
/** Jobs a screen reads when it opens, to resume following the ones still running (GET .../jobs?limit=20). */
export const BRAIN_JOBS_READ_MAX = 20;
/** Poll failures worth another try; any other (no access, gone, refused) stops at once. */
const TRANSIENT: readonly BrainShellErrorState["kind"][] = ["offline", "timeout", "unavailable"];

export function brainJobPollDelay(polls: number): number {
  return Math.min(BRAIN_JOB_POLL_MAX_MS, BRAIN_JOB_POLL_FIRST_MS * 2 ** Math.min(polls, 8));
}

export function brainJobFinished(status: BrainJobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

/**
 * A job answer checked field by field (a job, or the start answer `{ job, deduped }`); null without a valid `jobId`
 * and `status`. `steps`, `errorCode` and `nextAction` are read at the top level or under `result` (the last step's
 * summary, where `caughtUp: false` means there is more to read). An unknown error code is dropped (the screens word
 * only known codes), and the next action is only ever looked up in a fixed table.
 */
export function brainJobView(value: unknown): BrainJobView | null {
  const fields = record(record(value)?.job) ?? record(value);
  if (fields === null) return null;
  const { jobId } = fields;
  const status = STATUSES.find((candidate) => candidate === fields.status);
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId) || status === undefined) return null;
  const result = record(fields.result);
  const pick = (name: string): unknown => fields[name] ?? result?.[name];
  const steps = pick("steps");
  const errorCode = pick("errorCode");
  // A run's own next action ("" when it has none) wins; else a pass that left more to read asks for another run.
  const given = pick("nextAction");
  const nextAction = typeof given === "string" && given !== "" ? given
    : result?.caughtUp === false ? "run_again" : given;
  // A running job whose last answer was "busy" (another run of the project holds the lock) says so in `waiting`.
  const waiting = status === "running" && typeof result?.waiting === "string";
  return {
    jobId, status,
    steps: typeof steps === "number" && Number.isInteger(steps) && steps >= 0 && steps <= STEPS_MAX ? steps : null,
    errorCode: typeof errorCode === "string" && Object.hasOwn(BRAIN_JOB_CODE_COPY, errorCode) ? errorCode : null,
    nextAction: typeof nextAction === "string" ? nextAction.slice(0, NEXT_ACTION_MAX_CHARS) : "",
    ...(waiting ? { waiting } : {}),
  };
}

/**
 * The slot a job takes, as the screens name it: "sync:git" (the project's repository), "sync:<sourceId>", or
 * "extract:rules" / "extract:model"; null for any other request.
 */
export function brainJobKey(request: unknown): string | null {
  const fields = record(request);
  if (fields?.kind === "sync") {
    const { sourceId } = fields;
    if (sourceId === undefined) return "sync:git";
    return typeof sourceId === "string" && JOB_ID_PATTERN.test(sourceId) ? `sync:${sourceId}` : null;
  }
  if (fields?.kind === "extract") return fields.extractor === "model" ? "extract:model" : "extract:rules";
  return null;
}

/**
 * The queued and running jobs of a GET .../jobs answer (newest first), the newest one per slot (brainJobKey), in
 * that order. Anything unreadable is left out, so a bad answer only means nothing is resumed.
 */
export function brainActiveJobs(value: unknown): ReadonlyMap<string, BrainJobView> {
  const list = record(value)?.jobs;
  const active = new Map<string, BrainJobView>();
  if (!Array.isArray(list)) return active;
  for (const entry of list.slice(0, BRAIN_JOBS_READ_MAX)) {
    const key = brainJobKey(record(entry)?.request);
    const view = brainJobView(entry);
    if (key === null || view === null || brainJobFinished(view.status) || active.has(key)) continue;
    active.set(key, view);
  }
  return active;
}

/** The queued and running jobs of the project by slot; null while they load. */
export type BrainActiveJobs = ReadonlyMap<string, BrainJobView> | null;

/** A run started as a job to follow, or (no job of that kind on this gateway) the text of the direct run. */
export type BrainRunOutcome =
  | { readonly started: true; readonly view: BrainJobView } | { readonly started: false; readonly text: string };

/**
 * Starts the work as a background job (POST .../jobs, 202) for the caller to poll; a gateway that cannot take it (no
 * jobs route, or no job of that kind) runs it directly instead, and the outcome holds the text to show.
 */
export async function brainStartOrRun(api: BrainShellClient, projectId: string, input: BrainJobStartInput,
  direct: () => Promise<string>): Promise<BrainRunOutcome> {
  try {
    const view = brainJobView(await api.startJob(projectId, input));
    if (view === null) throw new Error("job answer not readable");
    return { started: true, view };
  } catch (error: unknown) {
    if (!brainJobsUnavailable(error)) throw error;
    return { started: false, text: await direct() };
  }
}

/**
 * The job of one slot (brainJobKey) of a card, which also follows, once, the run of that slot still queued or running
 * when the screen opened (`active`, from brainActiveJobs) as `name`, unless a run already started; so a reload or a
 * reopen shows it. A card follows each of its slots with its own job.
 */
export function useBrainSlotJob(api: BrainShellClient, projectId: string, active: BrainActiveJobs, slot: string,
  name: string, onFinished: (name: string, view: BrainJobView) => void) {
  const job = useBrainJob({
    poll: (jobId) => api.job(projectId, jobId), cancel: (jobId) => api.cancelJob(projectId, jobId), onFinished,
  });
  const done = useRef(false);
  const resume = useEffectEvent((view: BrainJobView | undefined) => {
    if (view !== undefined && job.watch === null) job.start(name, view);
  });
  useEffect(() => {
    if (active === null || done.current) return;
    done.current = true;
    resume(active.get(slot));
  }, [active, slot]);
  return job;
}

function finishOnce(finished: { round: number; readonly onFinished: (name: string, view: BrainJobView) => void },
  at: number, name: string, view: BrainJobView): void {
  if (finished.round >= at) return;
  finished.round = at;
  finished.onFinished(name, view);
}

/** watching: polls run. finished: the job ended. stopped: polling gave up (`error`, or null after the poll cap). */
export interface BrainJobWatch {
  readonly name: string; readonly view: BrainJobView; readonly phase: "watching" | "finished" | "stopped";
  readonly error: BrainShellErrorState | null;
}
interface WatchState extends BrainJobWatch {
  readonly polls: number; readonly failures: number; readonly round: number; readonly cancelling: boolean;
  readonly cancelError: BrainShellErrorState | null;
}

/**
 * Follows one background job: polls with backoff until it ends, then calls `onFinished` once. A newer `start`
 * replaces the job followed; an answer for a job or round the view has left is dropped. Unmounting stops the timer.
 */
export function useBrainJob({ poll, cancel, onFinished }: {
  readonly poll: (jobId: string) => Promise<unknown>; readonly cancel: (jobId: string) => Promise<unknown>;
  readonly onFinished: (name: string, view: BrainJobView) => void;
}) {
  const [watch, setWatch] = useState<WatchState | null>(null);
  const pollJob = useEffectEvent(poll);
  // onFinished runs once per round, whichever answer (a poll or the cancel) ends the job first.
  const finished = useRef({ round: 0, onFinished });
  useLayoutEffect(() => { finished.current.onFinished = onFinished; });
  // Every start and every "Check again" gets a new round, so an answer meant for an earlier one is never applied.
  const rounds = useRef(0);
  // A cancel still running when the screen closes must not report the job finished.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const watching = watch?.phase === "watching";
  const jobId = watching ? watch.view.jobId : null;
  const name = watch?.name ?? "";
  const polls = watch?.polls ?? 0;
  const failures = watch?.failures ?? 0;
  const round = watch?.round ?? 0;

  // An answer is applied only while its round is the newest; a start or "Check again" in the same turn moves on
  // synchronously, so a late answer is dropped before it is queued.
  useEffect(() => {
    if (jobId === null) return undefined;
    let live = true;
    const current = () => live && rounds.current === round;
    const fail = (error: BrainShellErrorState) => {
      const stop = failures + 1 >= BRAIN_JOB_MAX_FAILURES || !TRANSIENT.includes(error.kind)
        || polls + 1 >= BRAIN_JOB_MAX_POLLS;
      setWatch((previous) => previous!.phase !== "watching" ? previous : {
        ...previous!, polls: polls + 1, failures: failures + 1, phase: stop ? "stopped" : "watching",
        error: stop ? error : null,
      });
    };
    const timer = setTimeout(() => {
      pollJob(jobId).then((value) => {
        if (!current()) return;
        const view = brainJobView(value);
        if (view === null || view.jobId !== jobId) {
          console.warn("[brain] job answer not readable");
          fail({ kind: "unavailable" });
          return;
        }
        const ended = brainJobFinished(view.status);
        const capped = !ended && polls + 1 >= BRAIN_JOB_MAX_POLLS;
        // A cancel that ended the job may land first, before this answer was dropped; a finished job stays finished.
        setWatch((previous) => previous!.phase !== "watching" ? previous : {
          ...previous!, view, polls: polls + 1, failures: 0, error: null,
          phase: ended ? "finished" : capped ? "stopped" : "watching",
        });
        if (ended) finishOnce(finished.current, round, name, view);
      }, (error: unknown) => { if (current()) fail(brainShellError(error)); });
    }, brainJobPollDelay(polls));
    return () => { live = false; clearTimeout(timer); };
  }, [jobId, name, polls, failures, round]);

  const start = (jobName: string, view: BrainJobView) => {
    const at = rounds.current + 1;
    rounds.current = at;
    const ended = brainJobFinished(view.status);
    setWatch({
      name: jobName, view, phase: ended ? "finished" : "watching", error: null, polls: 0, failures: 0, round: at,
      cancelling: false, cancelError: null,
    });
    if (ended) finishOnce(finished.current, at, jobName, view);
  };

  const checkAgain = () => {
    if (watch?.phase !== "stopped") return;
    const at = rounds.current + 1;
    rounds.current = at;
    setWatch({ ...watch, phase: "watching", error: null, polls: 0, failures: 0, round: at, cancelling: false });
  };

  const stop = () => {
    if (!watching || watch.cancelling) return;
    const { view: { jobId: id }, round: at } = watch;
    setWatch({ ...watch, cancelling: true, cancelError: null });
    cancel(id).then((value) => {
      if (!mounted.current || rounds.current !== at) return;
      const view = brainJobView(value);
      const ended = view !== null && view.jobId === id && brainJobFinished(view.status) ? view : null;
      setWatch((previous) => ended === null ? { ...previous!, cancelling: false }
        : { ...previous!, view: ended, phase: "finished", cancelling: false });
      if (ended !== null) finishOnce(finished.current, at, name, ended);
    }, (error: unknown) => {
      if (!mounted.current || rounds.current !== at) return;
      const cancelError = brainShellError(error);
      setWatch((previous) => ({ ...previous!, cancelling: false, cancelError }));
    });
  };

  const view: BrainJobWatch | null = watch === null ? null
    : { name: watch.name, view: watch.view, phase: watch.phase, error: watch.error };
  return {
    watch: view, running: watching, cancelling: watch?.cancelling === true, cancelError: watch?.cancelError ?? null,
    start, checkAgain, stop,
  };
}
