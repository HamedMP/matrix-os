// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainApp } from "../../packages/ui/src/brain/BrainApp.js";
import { brainErrorText } from "../../packages/ui/src/brain/brain-format.js";
import { BrainCite, BrainSnippet } from "../../packages/ui/src/brain/brain-ui.js";
import type { BrainSearchHitView, BrainSearchView } from "../../packages/ui/src/brain/brain-types.js";
import { apiError, cite, fakeBrainApi, FRESH, PROJECT } from "./brain-fixtures.js";

afterEach(() => { cleanup(); });

const PROJECTS = [
  { id: PROJECT, name: "matrix-os", slug: "matrix-os" },
  { id: "proj_second", name: "second", slug: "second" },
];

function hit(hitId: string, extra: Partial<BrainSearchHitView> = {}): BrainSearchHitView {
  return {
    hitId, type: "document", score: 1, matchedBy: ["text"],
    snippet: { field: "body", text: "We chose Postgres for app data", highlights: [[9, 17]], truncatedStart: false, truncatedEnd: false },
    claim: null, cite: cite("#2078"), ...extra,
  };
}

function searchView(items: BrainSearchHitView[], extra: Partial<BrainSearchView> = {}): BrainSearchView {
  return {
    q: "postgres", mode: "text", items, nextCursor: null,
    capability: { fullText: true, vector: "provider_not_configured", providerId: null }, freshness: FRESH, notices: [],
    ...extra,
  };
}

function renderApp(api = fakeBrainApi(), props: Partial<React.ComponentProps<typeof BrainApp>> = {}) {
  render(<BrainApp api={api} loadProjects={async () => PROJECTS} {...props} />);
  return api;
}

async function ask(text: string) {
  fireEvent.change(await screen.findByRole("searchbox", { name: "Ask the Company Brain" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}

describe("BrainApp", () => {
  it("retries a failed project list and explains an empty one", async () => {
    let calls = 0;
    const loadProjects = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw apiError("unauthorized");
      return [];
    });
    render(<BrainApp api={fakeBrainApi()} loadProjects={loadProjects} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("You do not have access");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No projects yet.")).toBeTruthy();
  });

  it("opens on the project this browser picked last, and remembers a new pick", async () => {
    window.localStorage.setItem("matrix-os:brain-project", "proj_second");
    const api = renderApp(fakeBrainApi());
    const picker = await screen.findByRole("combobox", { name: "Project" });
    expect(picker).toHaveValue("proj_second");
    fireEvent.change(picker, { target: { value: PROJECT } });
    expect(window.localStorage.getItem("matrix-os:brain-project")).toBe(PROJECT);
    cleanup();
    // A remembered project that is gone falls back to the first one; storage that throws is only logged.
    window.localStorage.setItem("matrix-os:brain-project", "proj_gone");
    renderApp(api);
    expect(await screen.findByRole("combobox", { name: "Project" })).toHaveValue(PROJECT);
    cleanup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    renderApp(api);
    expect(await screen.findByRole("combobox", { name: "Project" })).toHaveValue(PROJECT);
    expect(warn).toHaveBeenCalledWith("[brain] remembered project unavailable", "SecurityError");
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "proj_second" } });
    expect(warn).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("shows its heading unless the window title bar already names it", async () => {
    renderApp();
    expect(screen.getByRole("heading", { level: 1, name: "Company Brain" })).toBeTruthy();
    await screen.findAllByRole("tab");
    cleanup();
    renderApp(fakeBrainApi(), { showHeading: false });
    await screen.findAllByRole("tab");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Company Brain" })).toBeTruthy();
  });

  it("shows the projects and the seven screens, and moves between them by keyboard and click", async () => {
    const api = renderApp();
    expect(screen.getByRole("status")).toHaveTextContent("Loading projects...");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Ask", "Today", "Decisions", "Commitments", "Risks", "Timeline", "Sources"]);
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tabs[0]!.id);
    expect(screen.getByText("Ask about a decision, a file, a person or a pull request.")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(PROJECT);
    const tablist = screen.getByRole("tablist");
    const selected = () => within(tablist).getByRole("tab", { selected: true }).textContent;
    expect(selected()).toBe("Ask");
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(selected()).toBe("Sources");
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(selected()).toBe("Ask");
    expect(document.activeElement).toBe(within(tablist).getByRole("tab", { name: "Ask" }));
    fireEvent.keyDown(tablist, { key: "End" });
    expect(selected()).toBe("Sources");
    fireEvent.keyDown(tablist, { key: "Home" });
    fireEvent.keyDown(tablist, { key: "ArrowDown" });
    expect(selected()).toBe("Today");
    fireEvent.keyDown(tablist, { key: "ArrowUp" });
    fireEvent.keyDown(tablist, { key: "a" });
    expect(selected()).toBe("Ask");
    for (const name of ["Today", "Decisions", "Commitments", "Risks", "Timeline"]) {
      fireEvent.click(within(tablist).getByRole("tab", { name }));
      expect(selected()).toBe(name);
    }
    await waitFor(() => expect(api.claims).toHaveBeenCalledWith(PROJECT, expect.objectContaining({ kind: "risk" })));
    expect(api.claims).toHaveBeenCalledWith(PROJECT, expect.objectContaining({ kind: "decision" }));
    expect(api.claims).toHaveBeenCalledWith(PROJECT, expect.objectContaining({ kind: "commitment" }));
    expect(api.brief).toHaveBeenCalled();
  });

  it("opens the picked project and falls back to the first for an unknown one", async () => {
    const api = renderApp(fakeBrainApi(), { initialProjectId: "proj_second", initialScreen: "today" });
    await waitFor(() => expect(api.brief).toHaveBeenCalledWith("proj_second", { window: "day" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: PROJECT } });
    await waitFor(() => expect(api.brief).toHaveBeenCalledWith(PROJECT, { window: "day" }));
    cleanup();
    const other = renderApp(fakeBrainApi(), { initialProjectId: "proj_gone", initialScreen: "today" });
    await waitFor(() => expect(other.brief).toHaveBeenCalledWith(PROJECT, { window: "day" }));
  });
});

describe("Ask", () => {
  it("searches, shows cited hits and pages", async () => {
    const api = renderApp(fakeBrainApi({
      search: vi.fn()
        .mockResolvedValueOnce(searchView([
          hit("claim-1", {
            type: "claim",
            claim: { claimId: "c1", kind: "decision", label: null, statement: "Use Postgres.", extractor: "rules/v1", stale: true },
          }),
          hit("doc-1", { snippet: { field: "title", text: "abc", highlights: [[2, 1], [5, 9], [0, 1], [0, 1]], truncatedStart: false, truncatedEnd: false } }),
        ], { nextCursor: "next", freshness: { caughtUp: false, pendingDocuments: 1000, pendingCapped: true } }))
        .mockRejectedValueOnce(apiError("timeout"))
        .mockResolvedValueOnce(searchView([hit("doc-2", { cite: cite("#1", { permalink: "" }) })])),
    }) as never);
    fireEvent.click(await screen.findByRole("button", { name: "Search" }));
    expect(api.search).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Search in" }), { target: { value: "claim" } });
    await ask("  postgres  ");
    const results = await screen.findByRole("list", { name: "Results" });
    expect(api.search).toHaveBeenCalledWith(PROJECT, { q: "postgres", types: ["claim"], limit: 20, cursor: undefined });
    expect(within(results).getByText("Use Postgres.")).toBeTruthy();
    expect(within(results).getByText("Outdated")).toBeTruthy();
    expect(within(results).getAllByText("Postgres", { selector: "mark" })).toHaveLength(1);
    expect(within(results).getByText("a", { selector: "mark" })).toBeTruthy();
    expect(screen.getByText(/Still reading 1000\+ new documents/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("took too long");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(results).getAllByRole("listitem")).toHaveLength(3));
    expect(api.search).toHaveBeenLastCalledWith(PROJECT, { q: "postgres", types: ["claim"], limit: 20, cursor: "next" });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("explains no results and errors, and offers Sources when nothing is connected", async () => {
    const api = renderApp(fakeBrainApi({
      search: vi.fn()
        .mockResolvedValueOnce(searchView([]))
        .mockRejectedValueOnce(apiError("server", "git_source_missing")),
    }) as never);
    await ask("nothing");
    expect(await screen.findByText('No results for "postgres".')).toBeTruthy();
    await ask("again");
    expect(await screen.findByRole("alert")).toHaveTextContent("Connect this project's repository in Sources first.");
    fireEvent.click(screen.getByRole("button", { name: "Open Sources" }));
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Sources");
    expect(api.gitReceipts).toHaveBeenCalled();
  });
});

describe("shared pieces", () => {
  it("words offline and a route that is not mounted (the other errors show on the screens)", () => {
    expect(brainErrorText({ kind: "offline" })).toContain("Can't reach Matrix OS");
    expect(brainErrorText({ kind: "not_found", code: "unknown" })).toContain("not turned on yet");
  });

  it("links only https permalinks, falls back to the label for a title and never repeats the same text", () => {
    render(<>
      <BrainCite cite={cite("#7", { permalink: "javascript:alert(1)", title: "" })} />
      <BrainCite cite={cite("#8")} />
      <BrainCite cite={cite("Note day", { permalink: "", title: "Note day" })} shown="Note day" />
      <BrainSnippet text="plain" highlights={[]} />
    </>);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://github.com/HamedMP/matrix-os/pull/8");
    expect(screen.getAllByText("#7")).toHaveLength(1);
    expect(screen.queryByText("Note day")).toBeNull();
    expect(screen.getByText("plain")).toBeTruthy();
  });
});
