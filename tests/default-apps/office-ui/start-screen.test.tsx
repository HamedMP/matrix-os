// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MatrixFileBrowser, OfficeStartScreen, RecentFileList, type StartFileEntry } from "../../../home/apps/_shared/office-ui";

afterEach(cleanup);

const NOW = Date.parse("2026-11-25T15:00:00Z");
const kindOf = () => ({ kind: "document" as const });

/** A home made of paths; `list` answers one folder at a time, folders first. */
function fakeFiles(paths: string[], options: { fail?: Set<string>; forbid?: Set<string> } = {}) {
  const calls: string[] = [];
  return {
    calls,
    async list(dir: string) {
      calls.push(dir);
      if (options.forbid?.has(dir)) throw Object.assign(new Error("no"), { name: "BridgeFileError", code: "forbidden" });
      if (options.fail?.delete(dir)) throw Object.assign(new Error("down"), { name: "BridgeFileError", code: "unavailable" });
      const prefix = dir === "" ? "" : `${dir}/`;
      const children = new Map<string, StartFileEntry>();
      for (const path of paths) {
        if (!path.startsWith(prefix)) continue;
        const [name, ...rest] = path.slice(prefix.length).split("/");
        if (!name) continue;
        children.set(name, { name, path: `${prefix}${name}`, kind: rest.length > 0 ? "dir" : "file", size: 1, modifiedAt: "2026-11-24T10:00:00Z" });
      }
      return { entries: [...children.values()], truncated: false };
    },
  };
}

describe("RecentFileList", () => {
  const items = [
    { path: "documents/plan.docx", name: "plan.docx", openedAt: "2026-11-25T14:00:00Z" },
    { path: "memo.docx", name: "memo.docx", openedAt: "2026-11-20T10:00:00Z" },
    { path: "work/q3.docx", name: "q3.docx", openedAt: "2026-11-24T10:00:00Z" },
  ];

  it("shows name, folder and when, and opens an entry", () => {
    const onOpen = vi.fn();
    render(<RecentFileList label="Recent documents" items={items} onOpen={onOpen} onRemove={vi.fn()} kindOf={kindOf} empty={<p>none</p>} now={NOW} />);
    const row = screen.getByRole("button", { name: /^plan\.docx, in documents, opened 1 hour ago/ });
    expect(row.textContent).toContain("documents");
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith("documents/plan.docx");
    expect(screen.getByRole("button", { name: /^memo\.docx, in Home/ })).toBeTruthy();
  });

  it("shows the empty state when there are no entries", () => {
    render(<RecentFileList label="Recent" items={[]} onOpen={vi.fn()} onRemove={vi.fn()} kindOf={kindOf} empty={<p>Nothing yet</p>} />);
    expect(screen.getByText("Nothing yet")).toBeTruthy();
  });

  it("keeps one tab stop and moves between rows with the arrow keys", () => {
    render(<RecentFileList label="Recent" items={items} onOpen={vi.fn()} onRemove={vi.fn()} kindOf={kindOf} empty={null} now={NOW} />);
    const rows = screen.getAllByRole("button", { name: /, in / });
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    expect(rows.map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(rows[1], { key: "End" });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(rows[2], { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove q3.docx from recent" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(rows[2]);
  });

  it("removes an entry with its button or the Delete key, and keeps focus in the list", async () => {
    const onRemove = vi.fn(async () => undefined);
    const { rerender } = render(<RecentFileList label="Recent" items={items} onOpen={vi.fn()} onRemove={onRemove} kindOf={kindOf} empty={null} now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove memo.docx from recent" }));
    expect(onRemove).toHaveBeenCalledWith("memo.docx");
    const first = screen.getByRole("button", { name: /^plan\.docx/ });
    first.focus();
    fireEvent.keyDown(first, { key: "Delete" });
    expect(onRemove).toHaveBeenLastCalledWith("documents/plan.docx");
    await act(async () => undefined);
    rerender(<RecentFileList label="Recent" items={items.slice(1)} onOpen={vi.fn()} onRemove={onRemove} kindOf={kindOf} empty={null} now={NOW} />);
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^memo\.docx/);
  });
});

describe("MatrixFileBrowser", () => {
  const paths = ["documents/legal/msa.docx", "documents/budget.xlsx", "documents/brief.docx", "top.docx", "notes.md", "system/x.docx", ".hidden/y.docx", "~$top.docx"];

  it("lists folders and accepted files, navigates into folders and back through the breadcrumbs", async () => {
    const files = fakeFiles(paths);
    const onOpen = vi.fn();
    render(<MatrixFileBrowser files={files} accept={[".docx"]} onOpen={onOpen} appName="Docs" fileNoun="Word documents" kindOf={kindOf} now={NOW} />);
    const list = await screen.findByRole("list", { name: "Folders and files" });
    expect(within(list).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Folder documents", "top.docx, changed yesterday"]);

    fireEvent.click(within(list).getByRole("button", { name: "Folder documents" }));
    await screen.findByRole("button", { name: "Folder legal" });
    expect(screen.queryByText("budget.xlsx")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Folder legal");
    const trail = screen.getByRole("navigation", { name: "Folder path" });
    expect(within(trail).getByRole("button", { name: "documents" }).getAttribute("aria-current")).toBe("location");

    fireEvent.click(screen.getByRole("button", { name: /^brief\.docx/ }));
    expect(onOpen).toHaveBeenCalledWith("documents/brief.docx");

    fireEvent.click(within(trail).getByRole("button", { name: "Home" }));
    await screen.findByRole("button", { name: "Folder documents" });
    expect(files.calls).toEqual(["", "documents", ""]);
  });

  it("filters the folder by name and says when nothing matches", async () => {
    render(<MatrixFileBrowser files={fakeFiles(["a/brief.docx", "a/board report.docx", "a/plan.docx"])} initialDir="a" accept={[".docx"]} onOpen={vi.fn()} appName="Docs" fileNoun="Word documents" kindOf={kindOf} />);
    await screen.findByRole("button", { name: /^plan\.docx/ });
    const search = screen.getByRole("searchbox", { name: "Filter this folder by name" });
    fireEvent.change(search, { target: { value: "B" } });
    expect(screen.getAllByRole("button", { name: /\.docx/ }).map((button) => button.textContent?.replace(/Yesterday|\d.*$/, ""))).toHaveLength(2);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("Nothing in this folder matches “zzz”.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(screen.getAllByRole("button", { name: /\.docx/ })).toHaveLength(3);
  });

  it("moves from the search into the list and goes up a folder with Backspace", async () => {
    const files = fakeFiles(["a/b/one.docx", "a/two.docx"]);
    render(<MatrixFileBrowser files={files} initialDir="a/b" accept={[".docx"]} onOpen={vi.fn()} appName="Docs" fileNoun="Word documents" kindOf={kindOf} />);
    await screen.findByRole("button", { name: /^one\.docx/ });
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^one\.docx/);
    fireEvent.keyDown(document.activeElement!, { key: "Backspace" });
    await screen.findByRole("button", { name: "Folder b" });
    expect(files.calls.at(-1)).toBe("a");
  });

  it("shows a listing failure with a retry, and a forbidden folder plainly", async () => {
    const files = fakeFiles(["top.docx"], { fail: new Set([""]) });
    render(<MatrixFileBrowser files={files} accept={[".docx"]} onOpen={vi.fn()} appName="Docs" fileNoun="Word documents" kindOf={kindOf} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be listed/);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: /^top\.docx/ });
    cleanup();
    render(<MatrixFileBrowser files={fakeFiles([], { forbid: new Set([""]) })} accept={[".docx"]} onOpen={vi.fn()} appName="Sheets" fileNoun="spreadsheets" kindOf={kindOf} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Sheets is not allowed to look in this folder.");
  });

  it("says when a folder has nothing the app opens", async () => {
    render(<MatrixFileBrowser files={fakeFiles(["a/notes.md"])} initialDir="a" accept={[".docx"]} onOpen={vi.fn()} appName="Docs" fileNoun="Word documents" kindOf={kindOf} />);
    expect(await screen.findByText("No folders or Word documents here.")).toBeTruthy();
  });

  it("draws at most 200 rows and says how many there are", async () => {
    const many = Array.from({ length: 230 }, (_, index) => `f${index}.docx`);
    render(<MatrixFileBrowser files={fakeFiles(many)} accept={[".docx"]} onOpen={vi.fn()} appName="Docs" fileNoun="Word documents" kindOf={kindOf} />);
    expect(await screen.findByText("Showing 200 of 230. Filter to find the rest.")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Folders and files" })).getAllByRole("button")).toHaveLength(200);
  });
});

describe("OfficeStartScreen", () => {
  function renderStart(overrides: { items?: { path: string; name: string; openedAt: string }[] } = {}) {
    const handlers = { create: vi.fn(), choose: vi.fn(), open: vi.fn(), remove: vi.fn(), markdown: vi.fn() };
    render(
      <OfficeStartScreen
        appName="Docs"
        artwork="art.png"
        create={{
          heading: "Start a new document",
          templates: [
            { id: "blank", label: "Blank document", preview: <svg /> },
            { id: "memo", label: "Memo", description: "To, from, subject", preview: <svg /> },
          ],
          onCreate: handlers.create,
          more: [{ id: "markdown", label: "From Markdown…", onClick: handlers.markdown }],
        }}
        local={{ accept: [".docx"], noun: "a Word document", onChoose: handlers.choose }}
        recents={{ heading: "Recent documents", items: overrides.items ?? [], onOpen: handlers.open, onRemove: handlers.remove, emptyHeadline: "No recent documents", emptyDescription: "Documents you open appear here." }}
        browser={{ files: fakeFiles(["top.docx"]), accept: [".docx"], onOpen: handlers.open, fileNoun: "Word documents" }}
        kindOf={kindOf}
      />,
    );
    return handlers;
  }

  it("offers every way in, each one action away", async () => {
    const handlers = renderStart();
    for (const name of ["Start a new document", "From this computer", "Recent documents", "From Matrix"]) expect(screen.getByRole("heading", { name })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Memo/ }));
    expect(handlers.create).toHaveBeenCalledWith("memo");
    fireEvent.click(screen.getByRole("button", { name: "From Markdown…" }));
    expect(handlers.markdown).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose a file…" }));
    expect(handlers.choose).toHaveBeenCalled();
    expect(screen.getByText(".docx, up to 10 MB")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /^top\.docx/ }));
    expect(handlers.open).toHaveBeenCalledWith("top.docx");
  });

  it("turns the empty recent list into a pointer to the Matrix files", async () => {
    renderStart();
    expect(screen.getByRole("heading", { name: "No recent documents" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Browse your files" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("searchbox")));
  });
});
