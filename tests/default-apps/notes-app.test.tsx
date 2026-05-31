// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Tiptap rich editor ships its own React copy under the app's node_modules,
// which collides with the root React in the jsdom runtime ("Invalid hook call").
// It is exercised in the build + manually; here we mock the local RichEditor
// module so we can assert the app's list, persistence, and filtering behavior.
vi.mock("../../home/apps/notes/src/RichEditor", () => ({
  default: ({ note }: { note: { content: string } }) =>
    React.createElement("div", { "data-testid": "rich-editor-mock" }, note.content),
}));

const { default: App } = await import("../../home/apps/notes/src/App");

type DbRow = Record<string, unknown>;

type FakeDb = {
  find: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  onChange: ReturnType<typeof vi.fn>;
  rows: DbRow[];
};

function installMatrixDb(initial: DbRow[] = []): FakeDb {
  const rows: DbRow[] = [...initial];
  let seq = 0;
  const db = {
    rows,
    find: vi.fn(async () => rows.map((row) => ({ ...row }))),
    insert: vi.fn(async (_table: string, data: DbRow) => {
      seq += 1;
      const id = `db-${seq}`;
      rows.unshift({ id, created_at: new Date().toISOString(), ...data });
      return { id };
    }),
    update: vi.fn(async (_table: string, id: string, data: DbRow) => {
      const found = rows.find((row) => row.id === id);
      if (found) Object.assign(found, data);
      return { ok: true };
    }),
    delete: vi.fn(async (_table: string, id: string) => {
      const idx = rows.findIndex((row) => row.id === id);
      if (idx >= 0) rows.splice(idx, 1);
      return { ok: true };
    }),
    onChange: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "MatrixOS", {
    configurable: true,
    value: { db },
  });
  return db as unknown as FakeDb;
}

describe("Notes app", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
  });

  it("renders the document list from the Matrix DB", async () => {
    installMatrixDb([
      {
        id: "n-1",
        title: "Launch plan",
        content: "Ship the canvas upgrade",
        content_json: { type: "doc", content: [] },
        pinned: false,
        tags: "",
        updated_at: "2026-05-31T10:00:00.000Z",
      },
      {
        id: "n-2",
        title: "Weekend",
        content: "Groceries and rest",
        content_json: { type: "doc", content: [] },
        pinned: true,
        tags: "personal",
        updated_at: "2026-05-30T09:25:00.000Z",
      },
    ]);

    render(<App />);

    expect(await screen.findByText("Launch plan")).toBeTruthy();
    expect(screen.getByText("Weekend")).toBeTruthy();
  });

  it("shows the onboarding empty state when there are no notes", async () => {
    installMatrixDb([]);
    render(<App />);
    expect(await screen.findByText("No notes yet")).toBeTruthy();
    expect(screen.getByText("Capture a thought, draft a plan, or save a reference. Press Cmd/Ctrl+N to begin.")).toBeTruthy();
  });

  it("creates a note via the bridge insert when clicking New", async () => {
    const db = installMatrixDb([]);
    render(<App />);

    await screen.findByText("No notes yet");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New note" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(db.insert).toHaveBeenCalled());
    expect(db.insert.mock.calls[0][0]).toBe("notes");
    const inserted = db.insert.mock.calls[0][1] as DbRow;
    expect(inserted).toHaveProperty("title");
    expect(inserted).toHaveProperty("content");
    expect(inserted).toHaveProperty("content_json");
  });

  it("autosaves an edited title via a debounced bridge update", async () => {
    const db = installMatrixDb([
      {
        id: "n-1",
        title: "Draft",
        content: "Body text",
        content_json: { type: "doc", content: [] },
        pinned: false,
        tags: "",
        updated_at: "2026-05-31T10:00:00.000Z",
      },
    ]);

    render(<App />);
    const titleInput = (await screen.findByLabelText("Note title")) as HTMLInputElement;

    fireEvent.change(titleInput, { target: { value: "Renamed plan" } });
    expect(titleInput.value).toBe("Renamed plan");

    await waitFor(() => expect(db.update).toHaveBeenCalled(), { timeout: 3000 });
    const updateCall = db.update.mock.calls.at(-1)!;
    expect(updateCall[0]).toBe("notes");
    expect(updateCall[1]).toBe("n-1");
    expect((updateCall[2] as DbRow).title).toBe("Renamed plan");
  });

  it("filters notes by the search query", async () => {
    installMatrixDb([
      {
        id: "n-1",
        title: "Launch plan",
        content: "ship",
        content_json: { type: "doc", content: [] },
        pinned: false,
        tags: "",
        updated_at: "2026-05-31T10:00:00.000Z",
      },
      {
        id: "n-2",
        title: "Groceries",
        content: "milk eggs",
        content_json: { type: "doc", content: [] },
        pinned: false,
        tags: "",
        updated_at: "2026-05-30T10:00:00.000Z",
      },
    ]);

    render(<App />);
    await screen.findByText("Launch plan");

    const search = screen.getByPlaceholderText("Search notes");
    fireEvent.change(search, { target: { value: "groc" } });

    await waitFor(() => {
      expect(screen.queryByText("Launch plan")).toBeNull();
      expect(screen.getByText("Groceries")).toBeTruthy();
    });
  });

  it("surfaces pinned notes in a dedicated pinned section", async () => {
    installMatrixDb([
      {
        id: "n-1",
        title: "Pinned idea",
        content: "important",
        content_json: { type: "doc", content: [] },
        pinned: true,
        tags: "",
        updated_at: "2026-05-31T10:00:00.000Z",
      },
      {
        id: "n-2",
        title: "Loose thought",
        content: "later",
        content_json: { type: "doc", content: [] },
        pinned: false,
        tags: "",
        updated_at: "2026-05-30T10:00:00.000Z",
      },
    ]);

    const { container } = render(<App />);
    await screen.findByText("Pinned idea");
    const sections = Array.from(container.querySelectorAll(".note-list__section")).map((el) =>
      el.textContent?.trim(),
    );
    expect(sections.some((text) => /Pinned/i.test(text ?? ""))).toBe(true);
    expect(screen.getByText("Pinned idea")).toBeTruthy();
  });
});
