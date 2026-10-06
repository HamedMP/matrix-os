// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../../packages/ui/src/memory-workspace/MemoryWorkspace";
import {
  filterMemorySources,
  parseMemoryImport,
  safeMemoryMessage,
} from "../../packages/ui/src/memory-workspace/model";
const source = {
  id: "s1",
  title: "Travel preferences",
  content: "I prefer direct flights.",
  preview: "I prefer direct flights.",
  kind: "note" as const,
  collection: "Personal",
  revision: 1,
  occurredAt: null,
  updatedAt: "2026-10-05T10:00:00Z",
  ingestion: { hindsight: "ready" as const, openviking: "pending" as const },
};
function client() {
  return {
    snapshot: vi.fn().mockResolvedValue({
      sources: [source],
      engines: [
        { id: "hindsight", status: "configured" },
        { id: "openviking", status: "not_configured" },
      ],
      jobs: [],
    }),
    getSource: vi.fn().mockResolvedValue(source),
    importSources: vi.fn().mockResolvedValue({ sources: [source] }),
    updateSource: vi.fn().mockResolvedValue(source),
    deleteSource: vi.fn().mockResolvedValue(undefined),
    search: vi.fn(),
    compare: vi.fn().mockResolvedValue({
      query: "flights",
      results: [
        {
          engine: "hindsight",
          status: "ready",
          hits: [
            {
              sourceId: "s1",
              title: source.title,
              text: source.content,
              citation: { sourceId: "s1", revision: 1, label: source.title },
              provenance: "summary",
            },
          ],
          latencyMs: 12,
        },
        {
          engine: "openviking",
          status: "not_configured",
          hits: [],
          latencyMs: 0,
        },
      ],
    }),
  };
}
afterEach(cleanup);
describe("memory workspace", () => {
  it("keeps source filtering scoped and bounded", () => {
    expect(filterMemorySources([source], "email", "Personal", "")).toEqual([]);
    expect(filterMemorySources([source], "all", "Personal", "DIRECT")).toEqual([
      source,
    ]);
    expect(safeMemoryMessage(new Error("/secret postgres"))).toBe(
      "Something went wrong. Please try again.",
    );
  });
  it("imports text and rejects malformed or oversized exports", () => {
    expect(parseMemoryImport("note.md", "Hello")[0]?.content).toBe("Hello");
    expect(() => parseMemoryImport("export.json", "{}")).toThrow();
    expect(() => parseMemoryImport("note.md", "x".repeat(1_000_001))).toThrow();
  });
  it("browses originals and hands off source IDs rather than untrusted text", async () => {
    const api = client();
    const use = vi.fn();
    render(
      <MemoryWorkspace
        client={api}
        identity="owner-runtime"
        onUseInChat={use}
      />,
    );
    await screen.findByRole("button", { name: /Travel preferences/ });
    fireEvent.click(screen.getByRole("button", { name: /Travel preferences/ }));
    await screen.findByText("I prefer direct flights.", { selector: "p" });
    fireEvent.click(screen.getByRole("button", { name: "Use in Chat" }));
    await waitFor(() => expect(use).toHaveBeenCalledWith(["s1"]));
    expect(screen.getByText("Waiting")).toBeTruthy();
  });
  it("shows actual unavailable engine status in comparison", async () => {
    render(<MemoryWorkspace client={client()} identity="owner-runtime" />);
    await screen.findByRole("button", { name: /Travel preferences/ });
    fireEvent.click(screen.getByRole("button", { name: "Compare engines" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Ask your memory" }), {
      target: { value: "flights" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByText("Not configured");
    expect(screen.getByText("12 ms")).toBeTruthy();
  });
  it("keeps unsaved edits after a save failure", async () => {
    const api = client();
    api.updateSource.mockRejectedValue(new Error("secret provider"));
    render(<MemoryWorkspace client={api} identity="owner-runtime" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Travel preferences/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note content" }), {
      target: { value: "Keep my edits" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("alert");
    expect(
      (
        screen.getByRole("textbox", {
          name: "Note content",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Keep my edits");
  });
  it("resets private state on identity changes and ignores late snapshots", async () => {
    let resolve: (v: unknown) => void = () => {};
    const api = client();
    api.snapshot.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const view = render(<MemoryWorkspace client={api} identity="first" />);
    const other = client();
    other.snapshot.mockResolvedValue({ sources: [], engines: [], jobs: [] });
    view.rerender(<MemoryWorkspace client={other} identity="second" />);
    await screen.findByText("Your knowledge starts here");
    resolve({ sources: [source], engines: [], jobs: [] });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Travel preferences/ }),
      ).toBeNull(),
    );
  });
  it("searches the full corpus and loads pages without hiding total counts", async () => {
    const api = client();
    const snapshot = {
      sources: [source],
      engines: [],
      jobs: [],
      totalSources: 100000,
      filteredSources: 100000,
      collections: [{ name: "Personal", count: 100000 }],
      collectionsTruncated: false,
      hasMore: true,
      nextCursor: "100",
    };
    api.snapshot.mockResolvedValue(snapshot);
    render(<MemoryWorkspace client={api} identity="large-corpus" />);
    await screen.findByText("1 of 100000 sources");
    fireEvent.click(screen.getByRole("button", { name: "Load more sources" }));
    await waitFor(() =>
      expect(api.snapshot).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: "100", limit: 100 }),
      ),
    );
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search Library" }),
      { target: { value: "travel" } },
    );
    await waitFor(() =>
      expect(api.snapshot).toHaveBeenCalledWith(
        expect.objectContaining({ q: "travel" }),
      ),
    );
  });
  it("ignores an earlier source response after selecting another source", async () => {
    const api = client();
    const second = {
      ...source,
      id: "s2",
      title: "Another original",
      content: "Second source content",
    };
    api.snapshot.mockResolvedValue({
      sources: [source, second],
      engines: [],
      jobs: [],
    });
    let finish: (v: unknown) => void = () => {};
    api.getSource
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
      .mockResolvedValueOnce(second);
    render(<MemoryWorkspace client={api} identity="owner" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Travel preferences/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Another original/ }));
    await screen.findByRole("heading", { name: "Another original" });
    finish(source);
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Travel preferences" }),
      ).toBeNull(),
    );
  });
  it("previews native sources before importing selected records", async () => {
    const api = client();
    const records = [
      {
        externalId: "n1",
        title: "First note",
        content: "First content",
        kind: "note",
        collection: "Notes",
      },
      {
        externalId: "n2",
        title: "Second note",
        content: "Second content",
        kind: "note",
        collection: "Notes",
      },
    ];
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        status: "ready",
        collections: [{ id: "f1", label: "Personal folder" }],
        warnings: [],
      })
      .mockResolvedValueOnce({
        status: "preview",
        selectionId: "selection",
        records,
        warnings: [],
      })
      .mockResolvedValueOnce({
        status: "confirmed",
        records: [records[0]],
        warnings: [],
      });
    render(
      <MemoryWorkspace
        client={api}
        identity="owner"
        nativeImport={{ invoke }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apple Notes" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Personal folder" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Preview selected sources" }),
    );
    await screen.findByText("First note");
    expect(api.importSources).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Second note/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import 1 sources" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("memory:import-confirm", {
        selectionId: "selection",
        externalIds: ["n1"],
      }),
    );
    await waitFor(() =>
      expect(api.importSources).toHaveBeenCalledWith(
        [records[0]],
        expect.any(String),
      ),
    );
  });
});

it("keeps independently selected same-named exports as distinct originals", () => {
  const first = parseMemoryImport("Notes.md", "First original")[0];
  const second = parseMemoryImport("Notes.md", "Second original")[0];
  expect(first?.externalId).not.toBe(second?.externalId);
});
it("retries a native upload without consuming its confirmed preview twice", async () => {
  const api = client();
  api.importSources.mockRejectedValueOnce(new Error("network"));
  const records = [
    {
      externalId: "n1",
      title: "Retry note",
      content: "Original",
      kind: "note" as const,
      collection: "Notes",
    },
  ];
  const invoke = vi
    .fn()
    .mockResolvedValueOnce({
      status: "ready",
      collections: [{ id: "f1", label: "Folder" }],
    })
    .mockResolvedValueOnce({
      status: "preview",
      selectionId: "selection",
      records,
    })
    .mockResolvedValueOnce({ status: "confirmed", records });
  render(
    <MemoryWorkspace client={api} identity="owner" nativeImport={{ invoke }} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Import", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Apple Notes" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Folder" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Preview selected sources" }),
  );
  await screen.findByText("Retry note");
  fireEvent.click(screen.getByRole("button", { name: "Import 1 sources" }));
  await screen.findByText("Something went wrong. Please try again.");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Import 1 sources" }).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import 1 sources" }));
  await waitFor(() => expect(api.importSources).toHaveBeenCalledTimes(2));
  expect(
    invoke.mock.calls.filter((call) => call[0] === "memory:import-confirm"),
  ).toHaveLength(1);
  expect(api.importSources.mock.calls[0]).toEqual(
    api.importSources.mock.calls[1],
  );
});
