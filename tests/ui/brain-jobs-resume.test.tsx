// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainSources } from "../../packages/ui/src/brain/BrainSources.js";
import { brainActiveJobs, brainJobKey } from "../../packages/ui/src/brain/use-brain-job.js";
import { apiError, fakeBrainApi, PROJECT } from "./brain-fixtures.js";

/** Sources resumes following the runs that were still going when it opened (spec 563, Crash recovery). */
const GIT = {
  sourceId: "src_git", label: "matrix-os", externalRef: "x", webBase: null, status: "active" as const,
  createdAt: "x", updatedAt: "x",
};
const flush = () => act(async () => { await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("running jobs on open", () => {
  it("reads the project's running jobs, newest first, one per slot", () => {
    const listed = (status: string, request: unknown, jobId: string) => ({ jobId, status, request });
    const active = brainActiveJobs({ jobs: [
      listed("running", { kind: "extract", extractor: "model" }, "job_new"),
      listed("queued", { kind: "extract", extractor: "model" }, "job_old"),
      listed("succeeded", { kind: "sync" }, "job_done"),
      listed("queued", { kind: "sync", sourceId: "src_lin" }, "job_lin"),
      listed("running", { kind: "brief", window: "day" }, "job_brief"),
      listed("running", { kind: "sync", sourceId: "bad id" }, "job_bad"),
      { jobId: "no status", request: { kind: "sync" } },
    ] });
    expect([...active.keys()]).toEqual(["extract:model", "sync:src_lin"]);
    expect(active.get("extract:model")?.jobId).toBe("job_new");
    expect(brainJobKey({ kind: "extract" })).toBe("extract:rules");
    expect(brainJobKey({ kind: "sync" })).toBe("sync:git");
    for (const bad of [null, [], { jobs: "x" }]) expect(brainActiveJobs(bad).size).toBe(0);
  });
});

describe("Resuming runs on open", () => {
  const LIN = {
    sourceId: "src_lin", kind: "linear" as const, label: "Linear ENG", externalRef: null, status: "active" as const,
    revision: 3, createdAt: "x", updatedAt: "x", config: null, lastSync: null,
  };

  it("follows a run that is still going when the screen opens, and keeps its buttons off until it ends", async () => {
    const api = fakeBrainApi({
      gitReceipts: vi.fn(async () => ({ source: GIT, receipts: [] })),
      sources: vi.fn(async () => ({ items: [LIN], kinds: [] })),
      jobs: vi.fn(async () => ({ jobs: [
        { jobId: "job_model", status: "running", steps: 0, request: { kind: "extract", extractor: "model" },
          result: { waiting: "extraction_in_progress" } },
        { jobId: "job_lin", status: "queued", steps: 0, request: { kind: "sync", sourceId: "src_lin" } },
        { jobId: "job_git", status: "running", steps: 0, request: { kind: "sync" } },
      ] })),
      job: vi.fn(async (_project: string, jobId: string) => ({ jobId, status: "succeeded", steps: 1 })),
    });
    render(<BrainSources api={api} projectId={PROJECT} onOpenSources={vi.fn()} />);
    await flush();
    await flush();
    expect(api.jobs).toHaveBeenCalledWith(PROJECT, 20);
    const repository = screen.getByRole("region", { name: "Repository" });
    expect(within(repository).getByRole("status")).toHaveTextContent(
      "Finding claims with the model: waiting for another run of this project to finish, 0 steps done.",
    );
    expect(within(repository).getByRole("button", { name: "Find claims" })).toBeDisabled();
    const row = within(screen.getByRole("list", { name: "Connected sources" })).getByRole("listitem");
    expect(within(row).getByRole("status")).toHaveTextContent("Sync: waiting to start.");
    expect(within(row).getByRole("button", { name: "Syncing..." })).toBeDisabled();
    await advance(1_000);
    // The model run ended while an older sync still runs: the card follows that next, with Stop and buttons off.
    expect(within(repository).getByRole("status")).toHaveTextContent("Sync: running, 0 steps done.");
    expect(within(repository).getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(within(repository).getByRole("button", { name: "Find claims" })).toBeDisabled();
    await advance(1_000);
    expect(within(repository).getByRole("status")).toHaveTextContent("Sync: done, 1 step done.");
    expect(within(repository).getByRole("button", { name: "Find claims" })).toBeEnabled();
    expect(api.job).toHaveBeenCalledWith(PROJECT, "job_model");
    expect(api.job).toHaveBeenCalledWith(PROJECT, "job_lin");
  });

  it("leaves a run the card already follows alone when the list arrives late", async () => {
    let listJobs!: (value: unknown) => void;
    const api = fakeBrainApi({
      gitReceipts: vi.fn(async () => ({ source: GIT, receipts: [] })),
      sources: vi.fn(async () => ({ items: [], kinds: [] })),
      jobs: vi.fn(() => new Promise((resolve) => { listJobs = resolve; })),
      startJob: vi.fn(async () => ({ job: { jobId: "job_sync", status: "queued" }, deduped: false })),
    });
    render(<BrainSources api={api} projectId={PROJECT} onOpenSources={vi.fn()} />);
    await flush();
    const repository = screen.getByRole("region", { name: "Repository" });
    fireEvent.click(within(repository).getByRole("button", { name: "Sync now" }));
    await flush();
    listJobs({ jobs: [{ jobId: "job_model", status: "running", request: { kind: "extract", extractor: "model" } }] });
    await flush();
    expect(within(repository).getByRole("status")).toHaveTextContent("Sync: waiting to start.");
  });

  it("resumes nothing when the gateway has no jobs route", async () => {
    const api = fakeBrainApi({
      gitReceipts: vi.fn(async () => ({ source: GIT, receipts: [] })),
      sources: vi.fn(async () => ({ items: [], kinds: [] })),
      jobs: vi.fn(async () => { throw apiError("notFound"); }),
    });
    render(<BrainSources api={api} projectId={PROJECT} onOpenSources={vi.fn()} />);
    await flush();
    await flush();
    const repository = screen.getByRole("region", { name: "Repository" });
    expect(within(repository).queryByRole("status")).toBeNull();
    expect(within(repository).getByRole("button", { name: "Sync now" })).toBeEnabled();
  });
});

