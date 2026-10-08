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
