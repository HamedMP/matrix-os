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
