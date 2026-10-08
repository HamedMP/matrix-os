// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainSources } from "../../packages/ui/src/brain/BrainSources.js";
import { brainJobText } from "../../packages/ui/src/brain/brain-format.js";
import { BrainJobProgress } from "../../packages/ui/src/brain/brain-ui.js";
import {
  BRAIN_JOB_MAX_POLLS, brainJobPollDelay, brainJobView, useBrainJob,
} from "../../packages/ui/src/brain/use-brain-job.js";
import { apiError, fakeBrainApi, PROJECT } from "./brain-fixtures.js";

const GIT = {
  sourceId: "src_git", label: "matrix-os", externalRef: "x", webBase: null, status: "active" as const,
  createdAt: "x", updatedAt: "x",
};
const job = (status: string, extra: Record<string, unknown> = {}) => ({ jobId: "job_1", status, ...extra });
const flush = () => act(async () => { await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("job answers", () => {
  it("reads a job field by field and drops what it cannot trust", () => {
    expect(brainJobView(job("running", { steps: 2, errorCode: "sync_in_progress", nextAction: "run_again" }))).toEqual({
      jobId: "job_1", status: "running", steps: 2, errorCode: "sync_in_progress", nextAction: "run_again",
    });
    expect(brainJobView(job("failed", { result: { steps: 3, errorCode: "brain_capacity", nextAction: "x".repeat(99) } })))
      .toEqual({ jobId: "job_1", status: "failed", steps: 3, errorCode: "brain_capacity", nextAction: "x".repeat(64) });
    expect(brainJobView(job("succeeded", { steps: -1, errorCode: "secret text", nextAction: 4, result: [] }))).toEqual({
      jobId: "job_1", status: "succeeded", steps: null, errorCode: null, nextAction: "",
    });
    expect(brainJobView(job("queued", { steps: 1.5 }))?.steps).toBeNull();
    // The start answer wraps the job; a model pass that left more to read asks for another run.
    expect(brainJobView({ job: job("succeeded", { steps: 1, errorCode: null, result: { caughtUp: false } }), deduped: true }))
      .toEqual({ jobId: "job_1", status: "succeeded", steps: 1, errorCode: null, nextAction: "run_again" });
    expect(brainJobView(job("failed", { errorCode: "time_limit", result: { caughtUp: true } })))
      .toMatchObject({ errorCode: "time_limit", nextAction: "" });
    expect(brainJobView(job("queued", { steps: 2_000_000 }))?.steps).toBeNull();
    for (const bad of [null, "job_1", [job("queued")], job("paused"), { jobId: "bad id", status: "queued" }, { status: "queued" }]) {
      expect(brainJobView(bad)).toBeNull();
    }
  });

  it("backs off from 1 s to 10 s", () => {
    expect([0, 1, 2, 3, 4, 50].map(brainJobPollDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  });

  it("words every state", () => {
    const view = (status: "queued" | "running" | "succeeded" | "failed" | "cancelled", extra = {}) => ({
      jobId: "j", status, steps: null, errorCode: null, nextAction: "", ...extra,
    });
    expect(brainJobText("Sync", view("queued"))).toBe("Sync: waiting to start.");
    expect(brainJobText("Sync", view("running", { steps: 1 }))).toBe("Sync: running, 1 step done.");
    expect(brainJobText("Sync", view("succeeded", { steps: 2, nextAction: "run_again" })))
      .toBe("Sync: done, 2 steps done. There is more to read; run it again.");
    expect(brainJobText("Sync", view("failed", { errorCode: "brain_capacity" }))).toBe("Sync: failed. The project brain is full.");
    expect(brainJobText("Sync", view("failed"))).toBe("Sync: failed.");
    expect(brainJobText("Sync", view("failed", { errorCode: "step_limit" })))
      .toBe("Sync: failed. It reached its step limit; start it again to go on.");
    expect(brainJobText("Sync", view("cancelled"))).toBe("Sync: stopped.");
    // A paid run cut short by a restart, and a run held behind another run of the project.
    expect(brainJobText("Finding claims with the model", view("failed", { errorCode: "interrupted" })))
      .toBe("Finding claims with the model: failed. It stopped early when the server restarted; run it again to continue.");
    expect(brainJobView(job("running", { steps: 0, result: { waiting: "extraction_in_progress" } })))
      .toMatchObject({ status: "running", waiting: true });
    expect(brainJobView(job("succeeded", { result: { waiting: "extraction_in_progress" } }))).not.toHaveProperty("waiting");
    expect(brainJobText("Finding claims", view("running", { steps: 0, waiting: true })))
      .toBe("Finding claims: waiting for another run of this project to finish, 0 steps done.");
  });
});
