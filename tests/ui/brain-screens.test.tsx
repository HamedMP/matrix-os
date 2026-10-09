// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainAsk } from "../../packages/ui/src/brain/BrainAsk.js";
import { BrainClaims } from "../../packages/ui/src/brain/BrainClaims.js";
import { BrainSourceConnect } from "../../packages/ui/src/brain/BrainSourceConnect.js";
import { BrainTimeline } from "../../packages/ui/src/brain/BrainTimeline.js";
import { brainTimelineRef } from "../../packages/ui/src/brain/brain-format.js";
import { BrainToday } from "../../packages/ui/src/brain/BrainToday.js";
import type { BrainBriefLine, BrainBriefView, BrainTimelineView } from "../../packages/ui/src/brain/brain-types.js";
import { apiError, cite, claim, fakeBrainApi, FRESH, PROJECT } from "./brain-fixtures.js";

afterEach(cleanup);

function line(lineId: string, extra: Partial<BrainBriefLine> = {}): BrainBriefLine {
  return {
    lineId, text: `Line ${lineId}`, cites: [cite("#1")], claimId: null, claimKind: null, due: null, assignee: null,
    severity: null, ...extra,
  };
}

function brief(extra: Partial<BrainBriefView> = {}, full = true): BrainBriefView {
  return {
    date: "2026-10-02", window: "day", from: "2026-10-02T00:00:00Z", to: "2026-10-03T00:00:00Z",
    generatedAt: "2026-10-02T06:00:00Z", summary: null, truncated: false, stored: true,
    sections: full ? {
      attention: [line("a", { due: "2026-10-01", assignee: "Ann", severity: "high" })],
      decisions: [line("d")], commitments: [line("c")], risks: [line("r", { severity: "low" })],
      changes: [{ sourceId: "src_1", sourceKind: "git", label: "Repository", created: 2, revised: 1, items: [line("x")] }],
    } : { attention: [], decisions: [], commitments: [], risks: [], changes: [] },
    ...extra,
  };
}

function props(api = fakeBrainApi()) {
  return { api, projectId: PROJECT, onOpenSources: vi.fn() };
}

describe("Today", () => {
  it("shows every section, keeps a rebuild over a slower first load, switches to the week and reports failures", async () => {
    let finishFirst!: (view: BrainBriefView) => void;
    const generate = vi.fn()
      .mockResolvedValueOnce(brief({ summary: { text: "Rebuilt.", modelId: "m", generatedAt: "x" }, truncated: true }))
      .mockResolvedValueOnce(brief({ window: "week", date: "2026-10-04" }, false))
      .mockRejectedValueOnce(apiError("server", "git_source_missing"));
    const p = props(fakeBrainApi({
      brief: vi.fn()
        .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }))
        .mockRejectedValueOnce(apiError("timeout"))
        .mockResolvedValue(brief({ window: "week" }, false)),
      generateBrief: generate,
    }));
    const { container } = render(<BrainToday {...p} />);
    // One shrinkable column: long lines wrap at 390 px instead of widening the screen.
    expect(container.firstElementChild).toHaveClass("grid-cols-[minmax(0,1fr)]");
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    expect(await screen.findByText("Rebuilt.")).toBeTruthy();
    await act(async () => finishFirst(brief({ summary: { text: "Older.", modelId: "m", generatedAt: "x" } })));
    expect(screen.getByText("Rebuilt.")).toBeTruthy();
    expect(screen.queryByText("Older.")).toBeNull();
    expect(screen.getByText(/Brief for 2026-10-02, built 2026-10-02/)).toHaveTextContent("Some sections were cut short.");
    for (const text of ["Line a", "Due 2026-10-01", "high risk", "low risk", "2 new, 1 revised"]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getAllByRole("link")).toHaveLength(5);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings.indexOf("Changes")).toBeLessThan(headings.indexOf("Commitments"));
    fireEvent.click(screen.getByRole("button", { name: "This week" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("took too long");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Nothing needs attention.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "This week" })).toHaveAttribute("aria-pressed", "true");
    expect(p.api.brief).toHaveBeenLastCalledWith(PROJECT, { window: "week" });
    for (const text of ["No new decisions.", "No open commitments.", "No new risks.", "Nothing changed."]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    expect(screen.getByRole("button", { name: "Rebuilding..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();
    expect(await screen.findByText(/Week ending 2026-10-04/)).toBeTruthy();
    expect(generate).toHaveBeenLastCalledWith(PROJECT, { window: "week" });
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Sources" }));
    expect(p.onOpenSources).toHaveBeenCalled();
  });
});

describe("Claims", () => {
  const conflicts = {
    items: [{
      conflictId: "cfl_1", rule: "label_disagreement" as const, summary: "Two decisions disagree.", detectedAt: "x",
      sides: [
        { cite: cite("#1"), claimId: "c1", statement: null, quote: "q" },
        { cite: cite("#2"), claimId: null, statement: null, quote: "q" },
      ] as const,
    }],
    nextCursor: null,
  };

  it("lists claims with quotes, flags conflicts, filters and pages", async () => {
    const claims = vi.fn()
      .mockResolvedValueOnce({
        kind: "risk", path: null, match: null, nextCursor: "n2",
        items: [
          claim("c1", { kind: "risk", label: "Storage", stale: true, extractor: "model:claude/claims-v2", fields: { due: "2026-11-01", assignee: "Ann", severity: "high" } }),
          claim("c2", { kind: "risk", fields: { severity: "low" } }),
        ],
      })
      .mockResolvedValueOnce({ kind: "risk", path: null, match: null, nextCursor: null, items: [claim("c3", { kind: "risk" })] })
      .mockResolvedValueOnce({ kind: "risk", path: "src/", match: "folder", nextCursor: null, items: [] });
    const p = props(fakeBrainApi({ claims, conflicts: vi.fn(async () => conflicts) }));
    render(<BrainClaims {...p} kind="risk" />);
    const list = await screen.findByRole("list", { name: "Risks" });
    expect(claims).toHaveBeenCalledWith(PROJECT, { kind: "risk", path: "", limit: 50, cursor: undefined });
    expect(await within(list).findByText("Two decisions disagree.")).toBeTruthy();
    for (const text of ["Storage", "Conflict", "Outdated", "Due 2026-11-01", "Ann", "high risk", "low risk", "read by model", "Quote c1"]) {
      expect(within(list).getAllByText(text).length).toBeGreaterThan(0);
    }
    fireEvent.click(screen.getByRole("checkbox", { name: "Only conflicts" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox", { name: "Only conflicts" }));
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    fireEvent.change(screen.getByRole("textbox", { name: "File or folder" }), { target: { value: " src/ " } });
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(await screen.findByText("Try another path or clear the filters.")).toBeTruthy();
    expect(claims).toHaveBeenLastCalledWith(PROJECT, { kind: "risk", path: "src/", limit: 50, cursor: undefined });
  });

  it("flags a claim whose conflict is on a later page, and says when conflicts were cut", async () => {
    const conflict = (index: number, claimId: string | null) => ({
      ...conflicts.items[0], conflictId: `cfl_${index}`, summary: `Conflict ${index}.`,
      sides: [{ ...conflicts.items[0].sides[0], claimId }, conflicts.items[0].sides[1]] as const,
    });
    // A full first page about other claims, then the page that names c2.
    const first = { items: Array.from({ length: 50 }, (_, index) => conflict(index, `other${index}`)), nextCursor: "p2" };
    const pagesOf = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ items: [conflict(50, "c2")], nextCursor: null });
    const claims = vi.fn(async () => ({
      kind: "decision", path: null, match: null, nextCursor: null, items: [claim("c1"), claim("c2")],
    }));
    render(<BrainClaims {...props(fakeBrainApi({ claims, conflicts: pagesOf }))} kind="decision" />);
    const list = await screen.findByRole("list", { name: "Decisions" });
    expect(await within(list).findByText("Conflict 50.")).toBeTruthy();
    expect(pagesOf).toHaveBeenNthCalledWith(1, PROJECT, { limit: 50 });
    expect(pagesOf).toHaveBeenNthCalledWith(2, PROJECT, { limit: 50, cursor: "p2" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Only conflicts" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Statement c2")).toBeTruthy();
    expect(screen.queryByText(/conflicts are checked/)).toBeNull();
    cleanup();

    // A gateway that always has more stops at the list limit and says so.
    const endless = vi.fn(async () => first);
    render(<BrainClaims {...props(fakeBrainApi({ claims, conflicts: endless }))} kind="decision" />);
    expect(await screen.findByText("Only the first 500 conflicts are checked.")).toBeTruthy();
    expect(endless).toHaveBeenCalledTimes(10);
  });

  it("points to Sources when there are no claims and notes missing conflict checks", async () => {
    const p = props(fakeBrainApi({
      claims: vi.fn(async () => ({ kind: "decision", path: null, match: null, nextCursor: null, items: [] })),
      conflicts: vi.fn(async () => { throw apiError("notFound"); }),
    }));
    render(<BrainClaims {...p} kind="decision" />);
    expect(await screen.findByText("No decisions found.")).toBeTruthy();
    expect(await screen.findByText("Conflict checks are not available right now.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Sources" }));
    expect(p.onOpenSources).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Only conflicts" }));
    expect(screen.getByText("Try another path or clear the filters.")).toBeTruthy();
  });
});

describe("Timeline", () => {
  const view = (items: BrainTimelineView["items"], extra: Partial<BrainTimelineView> = {}): BrainTimelineView => ({
    entity: { entityId: "ent_1", kind: "file", key: "a.ts", displayName: "a.ts" }, items, nextCursor: null,
    freshness: FRESH, ...extra,
  });

  it("follows a file, a folder and a spec", async () => {
    const timeline = vi.fn()
      .mockResolvedValueOnce(view([
        { cite: cite("#5"), linkTypes: ["changed", "implements_spec"], mode: "inferred", matchedPaths: ["a.ts"] },
        { cite: cite("#6"), linkTypes: ["authored"], mode: "explicit", matchedPaths: [] },
      ], { nextCursor: "n", freshness: { caughtUp: false, pendingDocuments: 3, pendingCapped: false } }))
      .mockResolvedValueOnce(view([{ cite: cite("#7"), linkTypes: ["mentions"], mode: "explicit", matchedPaths: [] }]))
      .mockResolvedValueOnce(view([]))
      .mockRejectedValueOnce(apiError("notFound", "entity_not_found"));
    const p = props(fakeBrainApi({ timeline }));
    render(<BrainTimeline {...p} />);
    expect(screen.getByText("Pick a file, a person or a spec.")).toBeTruthy();
    const input = screen.getByRole("textbox", { name: "Name, path or spec" });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(timeline).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "a.ts" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    const list = await screen.findByRole("list", { name: "Timeline" });
    expect(timeline).toHaveBeenCalledWith(PROJECT, { entity: "file:a.ts", limit: 20, cursor: undefined });
    expect(within(list).getByText("implements spec")).toBeTruthy();
    expect(within(list).getByText("inferred")).toBeTruthy();
    expect(screen.getByText(/Still reading 3 new documents/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    fireEvent.change(input, { target: { value: "src/brain/" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText("Nothing touches this yet.")).toBeTruthy();
    expect(timeline).toHaveBeenLastCalledWith(PROJECT, { entity: "folder:src/brain", limit: 20, cursor: undefined });
    fireEvent.change(screen.getByRole("combobox", { name: "Timeline for" }), { target: { value: "spec" } });
    fireEvent.change(input, { target: { value: "551-company-brain-store" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing in the brain matches that yet.");
    expect(timeline).toHaveBeenLastCalledWith(PROJECT, { entity: "spec:specs/551-company-brain-store", limit: 20, cursor: undefined });
    expect(brainTimelineRef("spec", "specs/1-x")).toBe("spec:specs/1-x");
  });

  it("finds a person first, then follows the chosen one", async () => {
    const entities = vi.fn()
      .mockResolvedValueOnce({ items: [{ entityId: "ent_ann", kind: "person", key: "email:ann@x.co", displayName: "Ann" }], nextCursor: null })
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    const p = props(fakeBrainApi({ entities, timeline: vi.fn(async () => view([])) }));
    render(<BrainTimeline {...p} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Timeline for" }), { target: { value: "person" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Name, path or spec" }), { target: { value: "Ann" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    const people = await screen.findByRole("list", { name: "People" });
    expect(entities).toHaveBeenCalledWith(PROJECT, { kind: "person", q: "Ann", limit: 10 });
    fireEvent.click(within(people).getByRole("button", { name: /Ann/ }));
    await waitFor(() => expect(p.api.timeline).toHaveBeenCalledWith(PROJECT, { entity: "ent_ann", limit: 20, cursor: undefined }));
    expect(screen.queryByRole("list", { name: "People" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Name, path or spec" }), { target: { value: "Zed" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText('No one called "Zed" yet.')).toBeTruthy();
  });
});

// jsdom has no layout, so the 390 px rules are checked as the classes that make each long line shrink or wrap.
describe("Narrow screens (390 px)", () => {
  it("lets Ask results, cite titles, person keys and the kind select shrink instead of widening the screen", async () => {
    const longTitle = "A very long pull request title ".repeat(8);
    const api = fakeBrainApi({
      search: vi.fn(async () => ({
        q: "postgres", mode: "text", nextCursor: null, freshness: FRESH, notices: [],
        capability: { fullText: true, vector: "provider_not_configured", providerId: null },
        items: [{ hitId: "h1", type: "document", score: 1, matchedBy: ["text"], claim: null,
          snippet: { field: "body", text: "We chose Postgres", highlights: [], truncatedStart: false, truncatedEnd: false },
          cite: cite("#1", { title: longTitle }) }],
      })),
      entities: vi.fn(async () => ({ items: [{ entityId: "ent_ann", kind: "person",
        key: `email:${"ann.long.address".repeat(6)}@example.com`, displayName: "Ann" }], nextCursor: null })),
    });
    const { container, unmount } = render(<BrainAsk {...props(api)} />);
    expect(container.firstElementChild).toHaveClass("grid-cols-[minmax(0,1fr)]");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the Company Brain" }), { target: { value: "postgres" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const results = await screen.findByRole("list", { name: "Results" });
    expect(results).toHaveClass("grid-cols-[minmax(0,1fr)]");
    expect(within(results).getByRole("listitem")).toHaveClass("min-w-0");
    expect(within(results).getByText(longTitle.trim(), { exact: false })).toHaveClass("min-w-0", "truncate");
    unmount();

    render(<BrainTimeline {...props(api)} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Timeline for" }), { target: { value: "person" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Name, path or spec" }), { target: { value: "Ann" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    const person = within(await screen.findByRole("list", { name: "People" })).getByRole("button", { name: /Ann/ });
    expect(person).toHaveClass("h-auto", "max-w-full", "whitespace-normal", "break-all");
    cleanup();

    render(<BrainSourceConnect api={api} projectId={PROJECT} onConnected={vi.fn()}
      kinds={[{ kind: "slack_bridge", available: false, reason: "not_configured" }]} />);
    expect(screen.getByRole("combobox")).toHaveClass("w-full", "min-w-0", "max-w-full");
    expect(screen.getByRole("region", { name: "Connect a source" })).toHaveClass("grid-cols-[minmax(0,1fr)]");
  });
});
