// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainSources } from "../../packages/ui/src/brain/BrainSources.js";
import { brainSourceConfig, brainTypedValues } from "../../packages/ui/src/brain/brain-format.js";
import type { BrainExtractView, BrainReceiptsView } from "../../packages/ui/src/brain/brain-types.js";
import { apiError, COUNTS, fakeBrainApi, PROJECT, source } from "./brain-fixtures.js";

afterEach(cleanup);

const GIT = {
  sourceId: "src_git", label: "matrix-os", externalRef: "https://github.com/HamedMP/matrix-os",
  webBase: "https://github.com/HamedMP/matrix-os", status: "active" as const, createdAt: "x", updatedAt: "x",
};
const receipt = (receiptId: string, status: "succeeded" | "failed" | "running", errorCode: string | null = null) => ({
  receiptId, status, counts: COUNTS, nextAction: errorCode ? "retry_later" : "", errorCode,
  startedAt: "2026-10-02T10:00:00Z", finishedAt: null,
});
const extractView = (extra: Partial<BrainExtractView> = {}): BrainExtractView => ({
  status: "succeeded", errorCode: null, nextAction: "", extractor: "rules/v1", caughtUp: true, run: null,
  counts: { documentsProcessed: 10, documentsFailed: 0, claimsWritten: 4, claimsRemoved: 0, claimsRejected: 0, quotesRejected: 0 },
  usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ...extra,
});
const syncView = (status: "succeeded" | "failed", nextAction: string) => ({
  status, errorCode: null, nextAction, caughtUp: false, commitsProcessed: 3, commitsRemaining: 1, counts: COUNTS,
  notices: [], receipt: null,
});
const KINDS = [
  { kind: "git" as const, available: true, reason: null },
  { kind: "github" as const, available: true, reason: null },
  { kind: "linear" as const, available: true, reason: null },
  { kind: "matrix_chat" as const, available: false, reason: "not_connected" as const },
  { kind: "slack_bridge" as const, available: false, reason: "not_configured" as const },
];

function renderSources(overrides: Parameters<typeof fakeBrainApi>[0]) {
  const api = fakeBrainApi(overrides);
  render(<BrainSources api={api} projectId={PROJECT} onOpenSources={vi.fn()} />);
  return api;
}

describe("Repository", () => {
  it("connects, syncs, finds claims, runs the model one action at a time and shows receipts", async () => {
    let finishSync!: (view: ReturnType<typeof syncView>) => void;
    const api = renderSources({
      // An older gateway without the jobs route: every run goes the direct way.
      startJob: vi.fn(async () => { throw apiError("notFound"); }),
      gitReceipts: vi.fn().mockResolvedValueOnce({ source: null, receipts: [] }).mockResolvedValue({
        source: { ...GIT, status: "paused" as const, webBase: null },
        receipts: [receipt("r1", "succeeded"), receipt("r2", "failed", "git_timeout"), receipt("r3", "running")],
      }),
      registerGitSource: vi.fn(async () => ({ source: GIT, created: true })),
      syncGit: vi.fn()
        .mockReturnValueOnce(new Promise((resolve) => { finishSync = resolve; }))
        .mockResolvedValueOnce(syncView("failed", "retry_later")),
      extract: vi.fn()
        .mockResolvedValueOnce(extractView({ status: "failed", nextAction: "configure_model" }))
        .mockRejectedValueOnce(apiError("server", "extractor_not_configured"))
        .mockRejectedValueOnce(apiError("server"))
        .mockResolvedValueOnce(extractView({ extractor: "model:claude/claims-v2" })),
    });
    const repository = await screen.findByRole("region", { name: "Repository" });
    const button = (name: string) => within(repository).getByRole("button", { name });
    fireEvent.click(await within(repository).findByRole("button", { name: "Connect repository" }));
    expect(await within(repository).findByText("Repository connected. Sync it next.")).toBeTruthy();
    expect(api.registerGitSource).toHaveBeenCalledWith(PROJECT, {});
    expect(api.gitReceipts).toHaveBeenCalledWith(PROJECT, 5);
    expect(await within(repository).findAllByRole("listitem")).toHaveLength(3);
    expect(within(repository).getByText("Try again later.")).toBeTruthy();
    fireEvent.click(button("Find claims with the model"));
    expect(within(repository).getByRole("group", { name: "Read with the model" })).toHaveTextContent(/sends this project's pull requests.*to Anthropic/);
    expect(button("Find claims with the model")).toBeDisabled();
    // A confirm left open cannot start a paid run while a sync runs.
    fireEvent.click(button("Sync now"));
    expect(button("Read with the model")).toBeDisabled();
    await act(async () => finishSync(syncView("succeeded", "run_again")));
    expect(within(repository).getByText(/Synced: 3 written, 2 unchanged, 0 removed, 0 failed\. There is more/)).toBeTruthy();
    expect(button("Read with the model")).toBeEnabled();
    fireEvent.click(button("Cancel"));
    expect(within(repository).queryByRole("group", { name: "Read with the model" })).toBeNull();
    fireEvent.click(button("Sync now"));
    expect(await within(repository).findByText("Sync failed. Try again later.")).toBeTruthy();
    fireEvent.click(button("Find claims"));
    expect(await within(repository).findByText("Finding claims failed. Set up a claim reading model first.")).toBeTruthy();
    expect(api.extract).toHaveBeenCalledWith(PROJECT, { extractor: "rules" });
    const runModel = () => { fireEvent.click(button("Find claims with the model")); fireEvent.click(button("Read with the model")); };
    runModel();
    expect(await within(repository).findByRole("alert")).toHaveTextContent("No claim reading model is set up.");
    expect(api.extract).toHaveBeenLastCalledWith(PROJECT, { extractor: "model" });
    // A proxy that ends the request early answers 500 without a code; the run may still be going.
    runModel();
    expect(await within(repository).findByText(/model run may still be finishing/)).toBeTruthy();
    expect(within(repository).queryByRole("alert")).toBeNull();
    runModel();
    expect(await within(repository).findByText("Read 10 documents and found 4 claims.")).toBeTruthy();
  });
});

describe("Other sources", () => {
  it("syncs, pauses, resumes, lists syncs and removes", async () => {
    const sources = vi.fn(async () => ({
      items: [
        source("src_git", { kind: "git" }),
        source("src_lin", { lastSync: { status: "failed", startedAt: "2026-10-01T00:00:00Z", finishedAt: null, nextAction: "connect_account", errorCode: "auth_failed" } }),
        source("src_drv", { kind: "google_drive", status: "paused", revision: 7, lastSync: { status: "succeeded", startedAt: "2026-10-01T00:00:00Z", finishedAt: null, nextAction: "", errorCode: null } }),
      ],
      kinds: KINDS,
    }));
    const api = renderSources({
      // An older gateway without the jobs route: the source syncs run directly.
      startJob: vi.fn(async () => { throw apiError("notFound"); }),
      gitReceipts: vi.fn(async () => ({ source: GIT, receipts: [] })),
      sources,
      syncSource: vi.fn(async () => ({ ...syncView("succeeded", ""), sourceId: "src_lin", pages: 1, retryAfterSeconds: null })),
      updateSource: vi.fn().mockResolvedValueOnce(source("src_lin")).mockRejectedValueOnce(apiError("server", "revision_conflict")),
      sourceReceipts: vi.fn(async () => ({ source: source("src_lin"), receipts: [receipt("r9", "succeeded")] })),
      removeSource: vi.fn(async () => source("src_lin")),
    });
    const region = await screen.findByRole("region", { name: "Other sources" });
    const rows = within(await within(region).findByRole("list", { name: "Connected sources" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const [linear, drive] = rows as [HTMLElement, HTMLElement];
    expect(within(linear).getByText(/Last sync failed 2026-10-01\. Connect the account in Settings\./)).toBeTruthy();
    expect(within(drive).getByRole("button", { name: "Sync now" })).toBeDisabled();
    fireEvent.click(within(linear).getByRole("button", { name: "Sync now" }));
    expect(await within(linear).findByText(/Synced: 3 written/)).toBeTruthy();
    expect(api.syncSource).toHaveBeenCalledWith(PROJECT, "src_lin");
    fireEvent.click(within(linear).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.updateSource).toHaveBeenCalledWith(PROJECT, "src_lin", { expectedRevision: 3, status: "paused" }));
    fireEvent.click(within(drive).getByRole("button", { name: "Resume" }));
    expect(await within(drive).findByRole("alert")).toHaveTextContent("Reload and try again.");
    expect(api.updateSource).toHaveBeenLastCalledWith(PROJECT, "src_drv", { expectedRevision: 7, status: "active" });
    fireEvent.click(within(drive).getByRole("button", { name: "Try again" }));
    fireEvent.click(within(linear).getByRole("button", { name: "Show syncs" }));
    expect(await within(linear).findByRole("list", { name: "Recent syncs" })).toBeTruthy();
    expect(api.sourceReceipts).toHaveBeenCalledWith(PROJECT, "src_lin", 5);
    fireEvent.click(within(linear).getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(api.sourceReceipts).toHaveBeenCalledTimes(2));
    fireEvent.click(within(linear).getByRole("button", { name: "Hide syncs" }));
    expect(within(linear).queryByRole("list", { name: "Recent syncs" })).toBeNull();
    fireEvent.click(within(linear).getByRole("button", { name: "Disconnect" }));
    fireEvent.click(within(linear).getByRole("button", { name: "Keep" }));
    fireEvent.click(within(linear).getByRole("button", { name: "Disconnect" }));
    fireEvent.click(within(linear).getByRole("button", { name: "Disconnect for good" }));
    await waitFor(() => expect(api.removeSource).toHaveBeenCalledWith(PROJECT, "src_lin", 3));
    await waitFor(() => expect(sources.mock.calls.length).toBeGreaterThanOrEqual(4));
  });
});
