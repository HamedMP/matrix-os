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

describe("Repository background runs", () => {
  function renderRepository(overrides: Parameters<typeof fakeBrainApi>[0]) {
    const api = fakeBrainApi({
      gitReceipts: vi.fn(async () => ({ source: GIT, receipts: [] })),
      sources: vi.fn(async () => ({ items: [], kinds: [] })),
      ...overrides,
    });
    render(<BrainSources api={api} projectId={PROJECT} onOpenSources={vi.fn()} />);
    return api;
  }
  const region = () => screen.getByRole("region", { name: "Repository" });
  const button = (name: string) => within(region()).getByRole("button", { name });

  it("starts a sync job, polls with backoff through a failed poll and reloads the syncs when it ends", async () => {
    const api = renderRepository({
      startJob: vi.fn(async () => ({ job: job("queued"), deduped: false })),
      job: vi.fn()
        .mockResolvedValueOnce(job("running", { steps: 1 }))
        .mockRejectedValueOnce(apiError("offline"))
        .mockResolvedValueOnce(job("succeeded", { steps: 2, result: { nextAction: "run_again" } })),
    });
    await flush();
    fireEvent.click(button("Sync now"));
    await flush();
    expect(api.startJob).toHaveBeenCalledWith(PROJECT, { kind: "sync" });
    expect(within(region()).getByRole("status")).toHaveTextContent("Sync: waiting to start.");
    expect(within(region()).getByRole("progressbar", { name: "Sync progress" })).toBeTruthy();
    expect(button("Sync now")).toBeDisabled();
    expect(button("Find claims")).toBeDisabled();
    await advance(999);
    expect(api.job).not.toHaveBeenCalled();
    await advance(1);
    expect(api.job).toHaveBeenCalledWith(PROJECT, "job_1");
    expect(within(region()).getByRole("status")).toHaveTextContent("Sync: running, 1 step done.");
    await advance(2_000);
    expect(api.job).toHaveBeenCalledTimes(2);
    expect(within(region()).queryByRole("alert")).toBeNull();
    await advance(4_000);
    expect(within(region()).getByRole("status")).toHaveTextContent("Sync: done, 2 steps done. There is more to read; run it again.");
    expect(within(region()).queryByRole("progressbar")).toBeNull();
    expect(button("Sync now")).toBeEnabled();
    await flush();
    expect(api.gitReceipts).toHaveBeenCalledTimes(2);
    await advance(60_000);
    expect(api.job).toHaveBeenCalledTimes(3);
  });

  it("runs the model as a job after the confirm, stops it, and reports a refused stop", async () => {
    const api = renderRepository({
      startJob: vi.fn(async () => ({ jobId: "job_1", status: "running" })),
      job: vi.fn(async () => job("running")),
      cancelJob: vi.fn()
        .mockRejectedValueOnce(apiError("server", "revision_conflict"))
        .mockResolvedValueOnce(job("running"))
        .mockResolvedValueOnce(job("cancelled")),
    });
    await flush();
    fireEvent.click(button("Find claims with the model"));
    fireEvent.click(button("Read with the model"));
    await flush();
    expect(api.startJob).toHaveBeenCalledWith(PROJECT, { kind: "extract", extractor: "model" });
    expect(api.extract).not.toHaveBeenCalled();
    fireEvent.click(button("Stop"));
    expect(button("Stopping...")).toBeDisabled();
    await flush();
    expect(within(region()).getByRole("alert")).toHaveTextContent("Reload and try again.");
    fireEvent.click(button("Stop"));
    await flush();
    expect(within(region()).queryByRole("alert")).toBeNull();
    expect(within(region()).getByRole("status")).toHaveTextContent("Finding claims with the model: running.");
    fireEvent.click(button("Stop"));
    await flush();
    expect(within(region()).getByRole("status")).toHaveTextContent("Finding claims with the model: stopped.");
    expect(api.cancelJob).toHaveBeenCalledWith(PROJECT, "job_1");
    await flush();
    expect(api.gitReceipts).toHaveBeenCalledTimes(2);
  });

  it("says a model run may still be finishing only when a direct run was cut short", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = renderRepository({
      startJob: vi.fn()
        .mockRejectedValueOnce(apiError("server", "brain_unavailable"))
        .mockRejectedValueOnce(apiError("server"))
        .mockRejectedValueOnce(apiError("timeout"))
        .mockResolvedValueOnce({ id: "x" })
        .mockRejectedValue(apiError("notFound")),
      extract: vi.fn()
        .mockRejectedValueOnce(apiError("server", "brain_unavailable"))
        .mockRejectedValueOnce(apiError("timeout"))
        .mockRejectedValueOnce(apiError("server")),
    });
    const runModel = async () => {
      fireEvent.click(button("Find claims with the model"));
      fireEvent.click(button("Read with the model"));
      await flush();
      await flush();
    };
    await flush();
    // The jobs route failed, so no run started: an error, never a run still finishing.
    for (const text of ["is off right now", "is off right now", "took too long", "is off right now"]) {
      await runModel();
      expect(within(region()).getByRole("alert")).toHaveTextContent(text);
      expect(within(region()).queryByText(/may still be finishing/)).toBeNull();
    }
    expect(api.extract).not.toHaveBeenCalled();
    // No jobs route: a direct run the gateway refused is an error; one cut short may still be going.
    await runModel();
    expect(within(region()).getByRole("alert")).toHaveTextContent("is off right now");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await runModel();
      expect(within(region()).queryByRole("alert")).toBeNull();
      expect(within(region()).getByRole("status")).toHaveTextContent(/model run may still be finishing/);
    }
    expect(api.extract).toHaveBeenCalledTimes(3);
  });

  it("stops polling on a refused poll and checks again, and says a long run is still going", async () => {
    const api = renderRepository({
      startJob: vi.fn(async () => ({ jobId: "job_1", status: "queued" })),
      job: vi.fn()
        .mockRejectedValueOnce(apiError("unauthorized"))
        .mockResolvedValue(job("running")),
    });
    await flush();
    fireEvent.click(button("Find claims"));
    await flush();
    expect(api.startJob).toHaveBeenCalledWith(PROJECT, { kind: "extract", extractor: "rules" });
    await advance(1_000);
    expect(within(region()).getByRole("alert")).toHaveTextContent("You do not have access");
    expect(button("Find claims")).toBeEnabled();
    fireEvent.click(button("Try again"));
    for (let poll = 0; poll < BRAIN_JOB_MAX_POLLS; poll += 1) await advance(10_000);
    expect(api.job).toHaveBeenCalledTimes(BRAIN_JOB_MAX_POLLS + 1);
    expect(within(region()).getByText("It is still running. Check again later.")).toBeTruthy();
    await advance(60_000);
    expect(api.job).toHaveBeenCalledTimes(BRAIN_JOB_MAX_POLLS + 1);
    fireEvent.click(button("Check again"));
    await advance(1_000);
    expect(api.job).toHaveBeenCalledTimes(BRAIN_JOB_MAX_POLLS + 2);
  });

  it("gives up after three unreadable or failed polls in a row", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderRepository({
      startJob: vi.fn(async () => ({ jobId: "job_1", status: "queued" })),
      job: vi.fn()
        .mockResolvedValueOnce({ jobId: "job_2", status: "running" })
        .mockResolvedValueOnce("text")
        .mockRejectedValueOnce(apiError("timeout")),
    });
    await flush();
    fireEvent.click(button("Sync now"));
    await flush();
    await advance(1_000);
    await advance(2_000);
    expect(within(region()).queryByRole("alert")).toBeNull();
    await advance(4_000);
    expect(within(region()).getByRole("alert")).toHaveTextContent("took too long");
    expect(warn).toHaveBeenCalledWith("[brain] job answer not readable");
  });

  it("refuses an unreadable start, shows a run that already ended, and falls back when there is no jobs route", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = renderRepository({
      startJob: vi.fn()
        .mockResolvedValueOnce({ id: "x" })
        .mockResolvedValueOnce(job("succeeded"))
        .mockRejectedValueOnce(apiError("notFound"))
        .mockRejectedValueOnce(apiError("server", "job_kind_unavailable"))
        .mockRejectedValueOnce(apiError("server", "jobs_full")),
      syncGit: vi.fn(async () => ({
        status: "succeeded", errorCode: null, nextAction: "", caughtUp: true, commitsProcessed: 1, commitsRemaining: 0,
        counts: { read: 1, written: 1, unchanged: 0, deleted: 0, failed: 0 }, notices: [], receipt: null,
      })),
    });
    await flush();
    fireEvent.click(button("Sync now"));
    await flush();
    expect(within(region()).getByRole("alert")).toHaveTextContent("The Company Brain is off right now.");
    fireEvent.click(button("Sync now"));
    await flush();
    expect(within(region()).getByRole("status")).toHaveTextContent("Sync: done.");
    await flush();
    expect(api.gitReceipts).toHaveBeenCalledTimes(2);
    fireEvent.click(button("Sync now"));
    await flush();
    await flush();
    expect(api.syncGit).toHaveBeenCalledWith(PROJECT);
    expect(within(region()).getByText("Synced: 1 written, 0 unchanged, 0 removed, 0 failed.")).toBeTruthy();
    fireEvent.click(button("Sync now"));
    await flush();
    await flush();
    expect(api.syncGit).toHaveBeenCalledTimes(2);
    fireEvent.click(button("Sync now"));
    await flush();
    expect(within(region()).getByRole("alert")).toHaveTextContent("Too many runs are waiting. Try again later.");
    expect(api.syncGit).toHaveBeenCalledTimes(2);
  });
});
