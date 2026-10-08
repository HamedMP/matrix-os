// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainSources } from "../../packages/ui/src/brain/BrainSources.js";
import {
  BRAIN_SOURCE_DEFAULT_SETTINGS, brainExtensions, brainSourceConfig, brainSourceSettingsProblem,
} from "../../packages/ui/src/brain/brain-format.js";
import type { BrainSourceKindView } from "../../packages/ui/src/brain/brain-types.js";
import { fakeBrainApi, PROJECT, source } from "./brain-fixtures.js";

afterEach(cleanup);

const KINDS: BrainSourceKindView[] = (["github", "linear", "matrix_files", "google_calendar", "google_drive"] as const)
  .map((kind) => ({ kind, available: true, reason: null }));

function renderConnect(options: (kind: string) => unknown) {
  const api = fakeBrainApi({
    gitReceipts: vi.fn(async () => ({ source: null, receipts: [] })),
    sources: vi.fn(async () => ({ items: [], kinds: KINDS })),
    sourceOptions: vi.fn(async (_project: string, kind: string) => options(kind)),
    connectSource: vi.fn(async () => ({ source: source("src_new"), created: true })),
  });
  render(<BrainSources api={api} projectId={PROJECT} onOpenSources={vi.fn()} />);
  return api;
}

/** The form closes once a connect lands. */
const closed = () => waitFor(() => expect(screen.queryByRole("button", { name: "Connect" })).toBeNull());

async function pick(kind: string) {
  fireEvent.change(await screen.findByRole("combobox", { name: "Kind" }), { target: { value: kind } });
}

const one = (id: string) => ({ nextCursor: null, items: [{ id, label: id, detail: null }] });
/** What the gateway answers for a handler without listOptions (Linear, Google Drive, Google Calendar). */
const none = { nextCursor: null, items: [] };

describe("Connect settings", () => {
  it("lets GitHub and Linear leave out item types, but not all of them", async () => {
    const api = renderConnect((kind) => ({ kind, ...(kind === "github" ? one("HamedMP/matrix-os") : none) }));
    await pick("github");
    fireEvent.click(await screen.findByRole("radio", { name: "HamedMP/matrix-os" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Reviews" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Connect" })); });
    await waitFor(() => expect(api.connectSource).toHaveBeenLastCalledWith(PROJECT, {
      kind: "github",
      config: { repo: "HamedMP/matrix-os", mode: "integration", include: { pullRequests: true, reviews: false, issues: true } },
    }));
    await closed();
    await pick("linear");
    fireEvent.change(await screen.findByRole("textbox", { name: "Team keys" }), { target: { value: "ENG" } });
    for (const name of ["Issues", "Comments", "Project updates"]) fireEvent.click(screen.getByRole("checkbox", { name }));
    expect(screen.getByText("Pick at least one.")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Settings" })).toHaveAccessibleDescription("Pick at least one.");
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Comments" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Connect" })); });
    await waitFor(() => expect(api.connectSource).toHaveBeenLastCalledWith(PROJECT, {
      kind: "linear", config: { teamKeys: ["ENG"], include: { issues: false, comments: true, projectUpdates: false } },
    }));
    await closed();
  });

  it("turns GitHub reviews off with pull requests, as the gateway refuses reviews alone", async () => {
    const api = renderConnect((kind) => ({ kind, ...one("HamedMP/matrix-os") }));
    const choose = async () => {
      await pick("github");
      fireEvent.click(await screen.findByRole("radio", { name: "HamedMP/matrix-os" }));
    };
    await choose();
    const reviews = screen.getByRole("checkbox", { name: "Reviews" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Pull requests" }));
    expect(reviews).not.toBeChecked();
    expect(reviews).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pull requests" }));
    expect(reviews).toBeChecked();
    expect(reviews).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pull requests" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Connect" })); });
    await waitFor(() => expect(api.connectSource).toHaveBeenLastCalledWith(PROJECT, {
      kind: "github",
      config: { repo: "HamedMP/matrix-os", mode: "integration", include: { pullRequests: false, reviews: false, issues: true } },
    }));
    await closed();
    // Reviews alone are nothing the gateway reads.
    await choose();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pull requests" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Issues" }));
    expect(screen.getByText("Pick at least one.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("sets Matrix file endings and size, and the calendar window", async () => {
    const api = renderConnect((kind) => ({ kind, ...(kind === "matrix_files" ? one("docs") : none) }));
    await pick("matrix_files");
    fireEvent.click(await screen.findByRole("checkbox", { name: "docs" }));
    const endings = screen.getByRole("textbox", { name: "File endings" });
    fireEvent.change(endings, { target: { value: "md, bad ending!" } });
    expect(screen.getByText("List 1 to 32 file endings.")).toBeTruthy();
    expect(endings).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    fireEvent.change(endings, { target: { value: ".MD, mdx md" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Largest file" }), { target: { value: "1048576" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Connect" })); });
    await waitFor(() => expect(api.connectSource).toHaveBeenLastCalledWith(PROJECT, {
      kind: "matrix_files", config: { roots: ["docs"], extensions: ["md", "mdx"], maxFileBytes: 1_048_576 },
    }));
    await closed();
    await pick("google_calendar");
    fireEvent.change(await screen.findByRole("textbox", { name: "Calendar ids" }), { target: { value: "primary" } });
    const back = screen.getByRole("spinbutton", { name: "Days back" });
    const ahead = screen.getByRole("spinbutton", { name: "Days ahead" });
    fireEvent.change(back, { target: { value: "" } });
    expect(back).toHaveValue(null);
    expect(screen.getByText("Days run from 0 to 90.")).toBeTruthy();
    fireEvent.change(back, { target: { value: "30" } });
    fireEvent.change(ahead, { target: { value: "91" } });
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    fireEvent.change(ahead, { target: { value: "" } });
    expect(ahead).toHaveValue(null);
    fireEvent.change(ahead, { target: { value: "0" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Connect" })); });
    await waitFor(() => expect(api.connectSource).toHaveBeenLastCalledWith(PROJECT, {
      kind: "google_calendar", config: { calendarIds: ["primary"], includeEventBodies: false, pastDays: 30, futureDays: 0 },
    }));
    await closed();
    await pick("google_drive");
    expect(await screen.findByRole("textbox", { name: "Folder ids" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Settings" })).toBeNull();
  });

  it("checks settings and endings without the form", () => {
    expect(brainExtensions("")).toBeNull();
    expect(brainExtensions(Array.from({ length: 33 }, (_, index) => `e${index}`).join(","))).toBeNull();
    expect(brainSourceSettingsProblem("google_calendar", { ...BRAIN_SOURCE_DEFAULT_SETTINGS, pastDays: 1.5 }))
      .toBe("Days run from 0 to 90.");
    expect(brainSourceSettingsProblem("matrix_chat", BRAIN_SOURCE_DEFAULT_SETTINGS)).toBeNull();
    const noPullRequests = { ...BRAIN_SOURCE_DEFAULT_SETTINGS, include: { pullRequests: false } };
    expect(brainSourceSettingsProblem("github", noPullRequests)).toBeNull();
    expect(brainSourceConfig("github", ["a/b"], noPullRequests))
      .toMatchObject({ include: { pullRequests: false, reviews: false, issues: true } });
    expect(brainSourceSettingsProblem("github", { ...noPullRequests, include: { pullRequests: false, issues: false } }))
      .toBe("Pick at least one.");
    // A config is only built from valid settings; bad endings fall back to the defaults.
    expect(brainSourceConfig("matrix_files", ["docs"], { ...BRAIN_SOURCE_DEFAULT_SETTINGS, extensions: "!" }))
      .toEqual({ roots: ["docs"], extensions: ["md", "txt"], maxFileBytes: 262_144 });
  });
});
