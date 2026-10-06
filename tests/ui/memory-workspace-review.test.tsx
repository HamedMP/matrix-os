// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryEditor } from "../../packages/ui/src/memory-workspace/MemoryEditor";
import { MemoryImport } from "../../packages/ui/src/memory-workspace/MemoryImport";
import { MemorySearch } from "../../packages/ui/src/memory-workspace/MemorySearch";
import { MemoryWorkspace } from "../../packages/ui/src/memory-workspace/MemoryWorkspace";
import { parseMemoryImport } from "../../packages/ui/src/memory-workspace/model";
import type {
  MemoryWorkspaceClient,
  MemorySource,
  MemorySearchResult,
} from "../../packages/ui/src/memory-workspace/model";
const saved: MemorySource = {
  id: "committed-note",
  title: "First",
  content: "First body",
  preview: "First body",
  kind: "note",
  collection: "Notes",
  revision: 1,
  occurredAt: null,
  updatedAt: "2026-10-05T10:00:00Z",
  ingestion: { hindsight: "pending", openviking: "pending" },
};
function client() {
  return {
    snapshot: vi.fn().mockResolvedValue({
      sources: [],
      jobs: [],
      engines: [],
      totalSources: 1,
      filteredSources: 0,
      collections: [],
      collectionsTruncated: false,
      hasMore: false,
      nextCursor: null,
    }),
    getSource: vi.fn(),
    importSources: vi.fn().mockResolvedValue({ sources: [saved] }),
    updateSource: vi.fn().mockResolvedValue({ ...saved, revision: 2 }),
    deleteSource: vi.fn(),
    search: vi.fn(),
    compare: vi.fn(),
  } satisfies MemoryWorkspaceClient;
}
afterEach(cleanup);
it("reselecting an unchanged file preserves identity without merging different originals", () => {
  const first = parseMemoryImport("note.md", "body")[0];
  expect(parseMemoryImport("note.md", "body")[0].externalId).toBe(
    first.externalId,
  );
  expect(parseMemoryImport("note.md", "other")[0].externalId).not.toBe(
    first.externalId,
  );
  expect(parseMemoryImport("different.md", "body")[0].externalId).not.toBe(
    first.externalId,
  );
});
it("accepts wrapped source exports", () => {
  const records = [
    {
      externalId: "export:1",
      title: "Title",
      content: "Text",
      kind: "note",
      collection: "Notes",
    },
  ];
  expect(
    parseMemoryImport(
      "notes.json",
      JSON.stringify({ records, warnings: ["Some notes were skipped."] }),
    ),
  ).toEqual(records);
});
it("discards pending results when the question changes", async () => {
  const api = client();
  let resolve!: (value: MemorySearchResult) => void;
  api.search.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  render(<MemorySearch client={api} compare={false} onOpenSource={() => {}} />);
  const query = screen.getByRole("textbox", { name: "Ask your memory" });
  fireEvent.change(query, { target: { value: "old question" } });
  fireEvent.click(screen.getByRole("button", { name: "Search memory" }));
  fireEvent.change(query, { target: { value: "new question" } });
  await act(async () => {
    resolve({ engine: "hindsight", status: "ready", hits: [], latencyMs: 1 });
  });
  expect(screen.queryByRole("heading", { name: "Hindsight" })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Search memory" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
it("updates the committed note after its Library refresh fails", async () => {
  const api = client();
  const onSaved = vi
    .fn()
    .mockRejectedValueOnce(new Error("refresh_failed"))
    .mockResolvedValue(undefined);
  render(
    <MemoryEditor
      client={api}
      source={null}
      onClose={() => {}}
      onSaved={onSaved}
    />,
  );
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "First" },
  });
  fireEvent.change(screen.getByLabelText("Note content"), {
    target: { value: "First body" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create note" }));
  await screen.findByRole("alert");
  fireEvent.change(screen.getByLabelText("Note content"), {
    target: { value: "Corrected body" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: /Save changes|Create note/ }),
  );
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
  expect(api.importSources).toHaveBeenCalledTimes(1);
  expect(api.updateSource).toHaveBeenCalledWith(
    saved.id,
    expect.objectContaining({ baseRevision: 1, content: "Corrected body" }),
  );
});
it("retries the same import receipt after a lost response and Back/reselect", async () => {
  const api = client();
  api.importSources.mockRejectedValueOnce(new Error("lost_response"));
  const view = render(
    <MemoryImport
      client={api}
      onClose={() => {}}
      onImported={async () => {}}
    />,
  );
  const file = new File(["body"], "note.md", { type: "text/plain" });
  Object.defineProperty(file, "text", { value: async () => "body" });
  const choose = () =>
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
  choose();
  await screen.findByText("note");
  fireEvent.click(screen.getByRole("button", { name: /Import 1 source/ }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  choose();
  await screen.findByText("note");
  fireEvent.click(screen.getByRole("button", { name: /Import 1 source/ }));
  await waitFor(() => expect(api.importSources).toHaveBeenCalledTimes(2));
  expect(api.importSources.mock.calls[1]).toEqual(
    api.importSources.mock.calls[0],
  );
});
it("blocks replay capture and does not claim an off-page source was removed", async () => {
  const api = client();
  api.snapshot.mockResolvedValue({
    ...(await api.snapshot()),
    jobs: [
      {
        id: "job",
        sourceId: "off-page",
        revision: 1,
        engine: "hindsight",
        operation: "upsert",
        status: "pending",
        attempts: 0,
        updatedAt: saved.updatedAt,
      },
    ],
  });
  const view = render(<MemoryWorkspace client={api} identity="owner" />);
  await waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Learning activity" }));
  expect(screen.queryByText("Removed source")).toBeNull();
  expect(view.container.querySelector(".ph-no-capture")).toBeTruthy();
});
it("retries only the Library refresh after a known unchanged save", async () => {
  const api = client();
  const onSaved = vi
    .fn()
    .mockRejectedValueOnce(new Error("refresh_failed"))
    .mockResolvedValue(undefined);
  render(
    <MemoryEditor
      client={api}
      source={null}
      onClose={() => {}}
      onSaved={onSaved}
    />,
  );
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "First" },
  });
  fireEvent.change(screen.getByLabelText("Note content"), {
    target: { value: "First body" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create note" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
  expect(api.importSources).toHaveBeenCalledTimes(1);
  expect(api.updateSource).not.toHaveBeenCalled();
});
it("resolves an uncertain note creation with its unchanged receipt before saving later edits", async () => {
  const api = client();
  api.importSources.mockRejectedValueOnce(new Error("lost_response"));
  const onSaved = vi.fn().mockResolvedValue(undefined);
  render(
    <MemoryEditor
      client={api}
      source={null}
      onClose={() => {}}
      onSaved={onSaved}
    />,
  );
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "First" },
  });
  fireEvent.change(screen.getByLabelText("Note content"), {
    target: { value: "First body" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create note" }));
  await screen.findByRole("alert");
  fireEvent.change(screen.getByLabelText("Note content"), {
    target: { value: "Updated after lost response" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create note" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(api.importSources.mock.calls[1]).toEqual(
    api.importSources.mock.calls[0],
  );
  expect(api.updateSource).toHaveBeenCalledWith(
    saved.id,
    expect.objectContaining({
      baseRevision: 1,
      content: "Updated after lost response",
    }),
  );
});
it("shows bounded warnings from a wrapped Web export", async () => {
  const api = client();
  const view = render(
    <MemoryImport
      client={api}
      onClose={() => {}}
      onImported={async () => {}}
    />,
  );
  const text = JSON.stringify({
    records: [
      {
        externalId: "note:1",
        title: "Exported note",
        content: "Text",
        kind: "note",
        collection: "Notes",
        restoreDeleted: true,
      },
    ],
    warnings: ["Some notes were skipped."],
  });
  const file = new File([text], "notes.json");
  Object.defineProperty(file, "text", { value: async () => text });
  fireEvent.change(view.container.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
  await screen.findByText("Exported note");
  expect(screen.getByText("Some notes were skipped.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Import 1 source/ }));
  await waitFor(() => expect(api.importSources).toHaveBeenCalled());
  expect(api.importSources.mock.calls[0][0][0].restoreDeleted).toBe(true);
});
it("keeps file previews usable through React StrictMode effect replay", async () => {
  const api = client();
  const view = render(
    <React.StrictMode>
      <MemoryImport
        client={api}
        onClose={() => {}}
        onImported={async () => {}}
      />
    </React.StrictMode>,
  );
  const file = new File(["body"], "strict.md");
  Object.defineProperty(file, "text", { value: async () => "body" });
  fireEvent.change(view.container.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
  await screen.findByText("strict");
  fireEvent.click(screen.getByRole("button", { name: /Import 1 source/ }));
  await waitFor(() => expect(api.importSources).toHaveBeenCalledTimes(1));
});
