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
  { kind: "matrix_files" as const, available: true, reason: null },
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
    const confirm = () => within(repository).queryByRole("dialog", { name: "Read with the model" });
    fireEvent.click(button("Find claims with the model"));
    expect(confirm()).toHaveTextContent(/sends this project's pull requests.*to Anthropic/);
    // It floats over the receipts instead of pushing them down.
    expect(confirm()).toHaveClass("absolute");
    expect(within(repository).getByRole("list", { name: "Recent syncs" })).toBeTruthy();
    // Its trigger closes it again, and so do Escape and a click outside; a click inside keeps it.
    expect(button("Find claims with the model")).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(button("Find claims with the model"));
    expect(confirm()).toBeNull();
    expect(button("Find claims with the model")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button("Find claims with the model"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(confirm()).toBeNull();
    fireEvent.click(button("Find claims with the model"));
    fireEvent.pointerDown(within(confirm()!).getByText(/sends this project's pull requests/));
    fireEvent.pointerDown(button("Find claims with the model"));
    expect(confirm()).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(confirm()).toBeNull();
    fireEvent.click(button("Find claims with the model"));
    // A confirm left open (Sync started from the keyboard, with no pointer outside) cannot start a paid run meanwhile.
    fireEvent.click(button("Sync now"));
    expect(button("Read with the model")).toBeDisabled();
    await act(async () => finishSync(syncView("succeeded", "run_again")));
    expect(within(repository).getByText(/Synced: 3 written, 2 unchanged, 0 removed, 0 failed\. There is more/)).toBeTruthy();
    expect(button("Read with the model")).toBeEnabled();
    fireEvent.click(button("Cancel"));
    expect(confirm()).toBeNull();
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

describe("Connect a source", () => {
  it("connects a list kind with a name, caps the choices and closes the form", async () => {
    const sources = vi.fn(async () => ({ items: [], kinds: KINDS }));
    const roots = Array.from({ length: 9 }, (_, index) => ({ id: `docs${index}`, label: `docs${index}`, detail: index === 0 ? "12 files" : null }));
    const api = renderSources({
      gitReceipts: vi.fn(async () => ({ source: GIT, receipts: [] })),
      sources,
      sourceOptions: vi.fn(async () => ({ kind: "matrix_files", nextCursor: "c2", items: roots })),
      connectSource: vi.fn(async () => ({ source: source("src_new"), created: true })),
    });
    expect(await screen.findByText("No other sources yet.")).toBeTruthy();
    const kind = screen.getByRole("combobox", { name: "Kind" });
    expect(within(kind).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Choose a kind", "GitHub", "Linear", "Matrix files", "Matrix chats (Connect the account in Settings)",
      "Slack (Not set up on this server)",
    ]);
    const kinds = screen.getByRole("list", { name: "Source kinds" });
    expect(within(kinds).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "GitHubReady", "LinearReady", "Matrix filesReady", "Matrix chatsConnect the account in Settings",
      "SlackNot set up on this server",
    ]);
    fireEvent.change(kind, { target: { value: "matrix_files" } });
    const connect = screen.getByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();
    expect(await screen.findByText("Choose what to include (up to 8)")).toBeTruthy();
    expect(screen.getByText("Only the first 9 are shown.")).toBeTruthy();
    expect(api.sourceOptions).toHaveBeenCalledWith(PROJECT, "matrix_files", {});
    const boxes = screen.getAllByRole("checkbox");
    for (const box of boxes.slice(0, 8)) fireEvent.click(box);
    expect(boxes[8]).toBeDisabled();
    for (const box of boxes.slice(1, 8)) fireEvent.click(box);
    expect(boxes[8]).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Name (optional)" }), { target: { value: " Docs " } });
    fireEvent.click(connect);
    await waitFor(() => expect(api.connectSource).toHaveBeenCalledWith(PROJECT, {
      kind: "matrix_files", label: "Docs",
      config: { roots: ["docs0"], extensions: ["md", "txt"], maxFileBytes: 262_144 },
    }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Connect" })).toBeNull());
    expect(sources).toHaveBeenCalledTimes(2);
  });

  it("picks one repository, reports refusals, empty and failed choices", async () => {
    const api = renderSources({
      gitReceipts: vi.fn(async () => ({ source: GIT, receipts: [] })),
      sources: vi.fn(async () => ({ items: [], kinds: KINDS })),
      sourceOptions: vi.fn()
        .mockResolvedValueOnce({ kind: "github", nextCursor: null, items: [{ id: "HamedMP/matrix-os", label: "matrix-os", detail: null }] })
        .mockResolvedValueOnce({ kind: "matrix_files", nextCursor: null, items: [] })
        .mockRejectedValueOnce(apiError("server", "source_kind_unsupported")),
      connectSource: vi.fn(async () => { throw apiError("server", "source_not_connected"); }),
    });
    const kind = await screen.findByRole("combobox", { name: "Kind" });
    fireEvent.change(kind, { target: { value: "github" } });
    expect(await screen.findByText("Choose one")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /matrix-os/ }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connect the account for this source in Settings first.");
    expect(api.connectSource).toHaveBeenCalledWith(PROJECT, {
      kind: "github", config: { repo: "HamedMP/matrix-os", mode: "integration", include: { pullRequests: true, reviews: true, issues: true } },
    });
    fireEvent.change(kind, { target: { value: "matrix_files" } });
    expect(await screen.findByText("Nothing to choose from yet.")).toBeTruthy();
    fireEvent.change(kind, { target: { value: "" } });
    expect(screen.queryByText("Nothing to choose from yet.")).toBeNull();
    fireEvent.change(kind, { target: { value: "matrix_files" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("This source kind is not available.");
  });

  it("types a repository, a Slack scope or note tags when a kind lists no choices", async () => {
    const kinds = KINDS.map((view) => ({ ...view, available: true, reason: null }));
    const api = renderSources({
      gitReceipts: vi.fn(async () => ({ source: GIT, receipts: [] })),
      sources: vi.fn(async () => ({ items: [], kinds: [...kinds, { kind: "matrix_notes" as const, available: true, reason: null }] })),
      sourceOptions: vi.fn()
        .mockRejectedValueOnce(apiError("server", "source_kind_unsupported"))
        .mockResolvedValueOnce({ kind: "slack_bridge", nextCursor: null, items: [] })
        .mockRejectedValue(apiError("notFound")),
      connectSource: vi.fn(async () => ({ source: source("src_new"), created: true })),
    });
    const kind = await screen.findByRole("combobox", { name: "Kind" });
    fireEvent.change(kind, { target: { value: "github" } });
    const repo = await screen.findByRole("textbox", { name: "Repository (owner/name)" });
    const connect = screen.getByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();
    fireEvent.change(repo, { target: { value: "../matrix-os" } });
    expect(screen.getByText("Check what you typed.")).toBeTruthy();
    fireEvent.submit(connect.closest("form")!);
    expect(api.connectSource).not.toHaveBeenCalled();
    fireEvent.change(repo, { target: { value: " HamedMP/matrix-os " } });
    fireEvent.click(connect);
    await waitFor(() => expect(api.connectSource).toHaveBeenLastCalledWith(PROJECT, {
      kind: "github", config: { repo: "HamedMP/matrix-os", mode: "integration", include: { pullRequests: true, reviews: true, issues: true } },
    }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Kind" }), { target: { value: "slack_bridge" } });
    const scope = await screen.findByRole("textbox", { name: "Company Brain scope id" });
    fireEvent.change(scope, { target: { value: "6F1C2A4E-9B7D-4C3A-8E21-0D5B7A9C1E33" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connectSource).toHaveBeenLastCalledWith(PROJECT, {
      kind: "slack_bridge", config: { companyScopeId: "6F1C2A4E-9B7D-4C3A-8E21-0D5B7A9C1E33", channelIds: [] },
    }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Kind" }), { target: { value: "matrix_notes" } });
    const tags = await screen.findByRole("textbox", { name: "Tags (optional)" });
    expect(screen.getByText("Leave empty to include every note.")).toBeTruthy();
    fireEvent.change(tags, { target: { value: Array.from({ length: 21 }, (_, index) => `tag${index}`).join(",") } });
    expect(screen.getByText("Up to 20.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    fireEvent.change(tags, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.connectSource).toHaveBeenLastCalledWith(PROJECT, { kind: "matrix_notes", config: { folders: [] } }));
  });

  it("builds every kind's config and reads typed values", () => {
    const ids = ["a", "b"];
    expect(brainSourceConfig("matrix_files", ids)).toEqual({ roots: ids, extensions: ["md", "txt"], maxFileBytes: 262_144 });
    expect(brainSourceConfig("matrix_chat", ids)).toEqual({ chatIds: ids });
    expect(brainSourceConfig("google_drive", ids)).toEqual({ folderIds: ids });
    expect(brainSourceConfig("google_calendar", ids)).toEqual({ calendarIds: ids, includeEventBodies: false, pastDays: 14, futureDays: 14 });
    expect(brainTypedValues("matrix_notes", " #Design, roadmap design ")).toEqual(["design", "roadmap"]);
    expect(brainTypedValues("matrix_notes", "x")).toBeNull();
    expect(brainTypedValues("github", "a/..")).toBeNull();
    expect(brainTypedValues("github", "a/b/c")).toBeNull();
    expect(brainTypedValues("linear", " eng, Design ENG ")).toEqual(["ENG", "DESIGN"]);
    expect(brainTypedValues("linear", "ENG-1")).toBeNull();
    expect(brainTypedValues("google_drive", "1aB_c-D 1aB_c-D")).toEqual(["1aB_c-D"]);
    expect(brainTypedValues("google_drive", "folders/1aB")).toBeNull();
    expect(brainTypedValues("google_calendar", "primary, team@group.calendar.google.com"))
      .toEqual(["primary", "team@group.calendar.google.com"]);
    expect(brainTypedValues("google_calendar", "..")).toBeNull();
    // A kind that is only ever listed has no typed value.
    expect(brainTypedValues("matrix_files", "")).toEqual([]);
    expect(brainTypedValues("matrix_files", "docs")).toBeNull();
  });

  it("types Linear team keys, Drive folder ids and calendar ids, which their handlers never list", async () => {
    const kinds = (["linear", "google_drive", "google_calendar"] as const).map((kind) => ({ kind, available: true, reason: null }));
    const api = renderSources({
      gitReceipts: vi.fn(async () => ({ source: GIT, receipts: [] })),
      sources: vi.fn(async () => ({ items: [], kinds })),
      // The gateway's answer for a handler without listOptions.
      sourceOptions: vi.fn(async (_project: string, kind: string) => ({ kind, nextCursor: null, items: [] })),
      connectSource: vi.fn(async () => ({ source: source("src_new"), created: true })),
    });
    const choose = async (value: string) => {
      fireEvent.change(await screen.findByRole("combobox", { name: "Kind" }), { target: { value } });
    };
    await choose("linear");
    const teams = await screen.findByRole("textbox", { name: "Team keys" });
    expect(screen.queryByText("Nothing to choose from yet.")).toBeNull();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    fireEvent.change(teams, { target: { value: "ENG-1" } });
    expect(screen.getByText("Check what you typed.")).toBeTruthy();
    expect(teams).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    fireEvent.change(teams, { target: { value: "eng, design" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Connect" })); });
    await waitFor(() => expect(api.connectSource).toHaveBeenLastCalledWith(PROJECT, {
      kind: "linear", config: { teamKeys: ["ENG", "DESIGN"], include: { issues: true, comments: true, projectUpdates: true } },
    }));
    await choose("google_drive");
    fireEvent.change(await screen.findByRole("textbox", { name: "Folder ids" }), { target: { value: "1aB_c-D" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Connect" })); });
    await waitFor(() => expect(api.connectSource).toHaveBeenLastCalledWith(PROJECT, {
      kind: "google_drive", config: { folderIds: ["1aB_c-D"] },
    }));
    await choose("google_calendar");
    const calendars = await screen.findByRole("textbox", { name: "Calendar ids" });
    fireEvent.change(calendars, { target: { value: Array.from({ length: 11 }, (_, index) => `c${index}`).join(" ") } });
    expect(screen.getByText("Up to 10.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    fireEvent.change(calendars, { target: { value: "primary" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Connect" })); });
    await waitFor(() => expect(api.connectSource).toHaveBeenLastCalledWith(PROJECT, {
      kind: "google_calendar", config: { calendarIds: ["primary"], includeEventBodies: false, pastDays: 14, futureDays: 14 },
    }));
  });
});
