// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainAsk } from "../../packages/ui/src/brain/BrainAsk.js";
import { brainAskPath } from "../../packages/ui/src/brain/brain-format.js";
import type { BrainWhyItem, BrainWhyResult } from "../../packages/ui/src/brain/brain-types.js";
import { apiError, fakeBrainApi, FRESH, PROJECT } from "./brain-fixtures.js";

afterEach(cleanup);

function item(documentId: string, extra: Partial<BrainWhyItem> = {}): BrainWhyItem {
  return {
    documentId, kind: "pr", label: "#2078", title: "Company Brain store", date: "2026-10-01T10:00:00Z",
    permalink: "https://github.com/HamedMP/matrix-os/pull/2078", link: "explicit",
    summary: { heading: "Summary", text: "Adds the store.", truncated: false }, matchedPaths: [], matchedPathCount: 0,
    ...extra,
  };
}

function why(items: readonly BrainWhyItem[], extra: Partial<BrainWhyResult> = {}): BrainWhyResult {
  return {
    path: "packages/gateway/src/brain/why.ts", match: "file_or_folder", total: items.length, totalCapped: false, items,
    nextCursor: null, source: { sourceId: "src_git", webBase: null }, ...extra,
  };
}

function ask(text: string) {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search the Company Brain" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}

describe("Ask with a path", () => {
  it("tells paths from words, and leaves to search what the why route refuses", () => {
    for (const text of ["packages/gateway/src/brain/why.ts", "why.ts", "specs/", "a/b", "README.md", ".github/x.yml"]) {
      expect(brainAskPath(text)).toBe(text);
    }
    expect(brainAskPath("./src/a.ts")).toBe("src/a.ts");
    expect(brainAskPath("././specs/")).toBe("specs/");
    for (const text of [
      "why did we pick Postgres", "Postgres", "v1.2", "https://x.co/a", "e.g.", "a /b",
      "/", "/etc/x", "a//b", "../x", "a/./b", "a/../b", "specs//", "./", ".",
    ]) {
      expect(brainAskPath(text)).toBeNull();
    }
  });

  it("offers the words while the history loads and after the why route refuses the path", async () => {
    let refuse!: (error: unknown) => void;
    const api = fakeBrainApi({
      why: vi.fn(() => new Promise((_resolve, reject) => { refuse = reject; })),
      search: vi.fn(async (_projectId: string, query: { readonly q: string }) => ({
        q: query.q, mode: "text", items: [], nextCursor: null, freshness: FRESH, notices: [],
        capability: { fullText: true, vector: "extension_missing", providerId: null },
      })),
    });
    render(<BrainAsk api={api} projectId={PROJECT} onOpenSources={vi.fn()} />);
    ask("./src/a.ts");
    expect(api.why).toHaveBeenCalledWith(PROJECT, { path: "src/a.ts", limit: 20, cursor: undefined, detail: "brief" });
    expect(screen.getByRole("heading", { name: "History of src/a.ts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search the words instead" })).toBeTruthy();
    await act(async () => refuse(apiError("server", "invalid_request")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check what you typed and try again.");
    fireEvent.click(screen.getByRole("button", { name: "Search the words instead" }));
    expect(await screen.findByText('No results for "./src/a.ts".')).toBeTruthy();
    expect(api.search).toHaveBeenCalledWith(PROJECT, { q: "./src/a.ts", types: [], limit: 20, cursor: undefined });
    expect(screen.queryByRole("heading", { name: /History of/ })).toBeNull();
    ask("/etc/x");
    expect(await screen.findByText('No results for "/etc/x".')).toBeTruthy();
    expect(api.why).toHaveBeenCalledTimes(1);
    expect(api.search).toHaveBeenLastCalledWith(PROJECT, { q: "/etc/x", types: [], limit: 20, cursor: undefined });
  });

  it("shows a path's history, pages it, and searches the words on request", async () => {
    const api = fakeBrainApi({
      why: vi.fn()
        .mockResolvedValueOnce(why([
          item("d1", {
            link: "inferred", matchedPaths: ["a.ts", "b.ts", "c.ts", "d.ts"], matchedPathCount: 9,
            summary: { heading: null, text: "Long text", truncated: true },
          }),
          item("d2", { kind: "commit", label: "abc1234", summary: null, matchedPaths: ["a.ts"], matchedPathCount: 1 }),
        ], { nextCursor: "n2", total: 300, totalCapped: true }))
        .mockResolvedValueOnce(why([item("d3", { kind: "spec", label: "specs/546", permalink: "" })], { total: 1 })),
      search: vi.fn(async () => ({
        q: "packages/gateway/src/brain/why.ts", mode: "text", items: [], nextCursor: null, freshness: FRESH, notices: [],
        capability: { fullText: true, vector: "extension_missing", providerId: null },
      })),
    });
    render(<BrainAsk api={api} projectId={PROJECT} onOpenSources={vi.fn()} />);
    expect(screen.getByText(/Type a path, like/)).toBeTruthy();
    ask(" packages/gateway/src/brain/why.ts ");
    const list = await screen.findByRole("list", { name: "Path history" });
    expect(api.why).toHaveBeenCalledWith(PROJECT, {
      path: "packages/gateway/src/brain/why.ts", limit: 20, cursor: undefined, detail: "brief",
    });
    expect(api.search).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "History of packages/gateway/src/brain/why.ts" })).toBeTruthy();
    expect(screen.getByText("300+ changes, newest first.")).toBeTruthy();
    const [first, second] = within(list).getAllByRole("listitem") as [HTMLElement, HTMLElement];
    for (const text of ["pull request", "number inferred", "Long text...", "a.ts, b.ts, c.ts and 6 more"]) {
      expect(within(first).getByText(text)).toBeTruthy();
    }
    expect(within(first).getByRole("link")).toHaveAttribute("href", "https://github.com/HamedMP/matrix-os/pull/2078");
    expect(within(second).getByText("commit")).toBeTruthy();
    expect(within(second).getByText("a.ts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    expect(api.why).toHaveBeenLastCalledWith(PROJECT, {
      path: "packages/gateway/src/brain/why.ts", limit: 20, cursor: "n2", detail: "brief",
    });
    expect(within(list).getByText("spec")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search the words instead" }));
    expect(await screen.findByText('No results for "packages/gateway/src/brain/why.ts".')).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Path history" })).toBeNull();
  });

  it("says when nothing touches a folder, when the repository is missing, and when the read fails", async () => {
    const onOpenSources = vi.fn();
    const api = fakeBrainApi({
      why: vi.fn()
        .mockResolvedValueOnce(why([], { path: "specs", match: "folder", total: 0 }))
        .mockResolvedValueOnce(why([], { path: "a.ts", total: 1, source: null }))
        .mockRejectedValueOnce(apiError("server", "git_source_missing"))
        .mockResolvedValueOnce(why([item("d9")], { path: "c.ts", total: 1 })),
    });
    render(<BrainAsk api={api} projectId={PROJECT} onOpenSources={onOpenSources} />);
    ask("specs/");
    expect(await screen.findByText('Nothing in the history touches "specs" yet.')).toBeTruthy();
    expect(screen.getByRole("heading", { name: "History of specs/" })).toBeTruthy();
    ask("a.ts");
    expect(await screen.findByText("This project's repository is not connected.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Sources" }));
    expect(onOpenSources).toHaveBeenCalledTimes(1);
    ask("b.ts");
    expect(await screen.findByRole("alert")).toHaveTextContent("Connect this project's repository in Sources first.");
    fireEvent.click(screen.getByRole("button", { name: "Open Sources" }));
    expect(onOpenSources).toHaveBeenCalledTimes(2);
    ask("c.ts");
    expect(await screen.findByText("1 change, newest first.")).toBeTruthy();
  });
});
