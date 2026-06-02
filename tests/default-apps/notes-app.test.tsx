// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Tiptap rich editor ships its own React copy under the app's node_modules,
// which collides with the root React in the jsdom runtime ("Invalid hook call").
// It is exercised in the build + manually; here we mock the local RichEditor
// module so we can assert the app's list, persistence, and filtering behavior.
vi.mock("../../home/apps/notes/src/RichEditor", () => ({
  default: ({
    note,
    onChange,
  }: {
    note: { content: string };
    onChange: (patch: { content: string; content_json: { type: "doc"; content: [] } }) => void;
  }) =>
    React.createElement(
      "div",
      null,
      React.createElement("div", { "data-testid": "rich-editor-mock" }, note.content),
      React.createElement(
        "button",
        {
          type: "button",
          onClick: () => onChange({ content: "No tags left", content_json: { type: "doc", content: [] } }),
        },
        "Clear inline tag",
      ),
    ),
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

  it("loads notes in recently updated order", async () => {
    const db = installMatrixDb([]);
    render(<App />);

    await screen.findByText("No notes yet");

    expect(db.find).toHaveBeenCalledWith("notes", { orderBy: { updated_at: "desc" } });
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

  it("cancels pending autosave when deleting the active note", async () => {
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
    vi.useFakeTimers();
    fireEvent.change(titleInput, { target: { value: "Renamed plan" } });
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.delete).toHaveBeenCalledWith("notes", "n-1");
    expect(db.update).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("saves debounced local fallback edits without a database bridge", async () => {
    render(<App />);
    await screen.findByText("No notes yet");

    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    const titleInput = screen.getByLabelText("Note title") as HTMLInputElement;
    vi.useFakeTimers();
    fireEvent.change(titleInput, { target: { value: "Local draft" } });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("Note could not be saved.")).toBeNull();
    expect(screen.queryByText("Save failed")).toBeNull();
    vi.useRealTimers();
  });

  it("saves edits made before a newly inserted note receives its database id", async () => {
    vi.useFakeTimers();
    const db = installMatrixDb([]);
    let resolveInsert: ((value: { id: string }) => void) | null = null;
    db.insert.mockImplementationOnce(
      async (_table: string, data: DbRow) =>
        new Promise<{ id: string }>((resolve) => {
          db.rows.unshift({ id: "db-new", created_at: new Date().toISOString(), ...data });
          resolveInsert = resolve;
        }),
    );

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getAllByRole("button", { name: /new note/i })[0]);
    const titleInput = screen.getByLabelText("Note title") as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "Fast draft" } });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(db.update).not.toHaveBeenCalled();

    await act(async () => {
      resolveInsert?.({ id: "db-new" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.update).toHaveBeenCalledWith(
      "notes",
      "db-new",
      expect.objectContaining({ title: "Fast draft" }),
    );
  });

  it("saves edits when a new note insert resolves before the debounce fires", async () => {
    vi.useFakeTimers();
    const db = installMatrixDb([]);

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getAllByRole("button", { name: /new note/i })[0]);
    const titleInput = screen.getByLabelText("Note title") as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "Fast bridge draft" } });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(db.insert).toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.update).toHaveBeenCalledWith(
      "notes",
      "db-1",
      expect.objectContaining({ title: "Fast bridge draft" }),
    );
  });

  it("retries insert for an orphaned draft after the initial create fails", async () => {
    vi.useFakeTimers();
    const db = installMatrixDb([]);
    db.insert.mockRejectedValueOnce(new Error("temporary insert failure"));

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getAllByRole("button", { name: /new note/i })[0]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Note could not be created.")).toBeTruthy();

    const titleInput = screen.getByLabelText("Note title") as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "Recovered draft" } });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.insert).toHaveBeenCalledTimes(2);
    expect(db.insert.mock.calls[1][1]).toEqual(expect.objectContaining({ title: "Recovered draft" }));
    expect(db.update).not.toHaveBeenCalledWith(
      "notes",
      expect.stringMatching(/^note-/),
      expect.anything(),
    );
  });

  it("tracks a retry insert so concurrent debounces do not create duplicate rows", async () => {
    vi.useFakeTimers();
    const db = installMatrixDb([]);
    let resolveRetry: ((value: { id: string }) => void) | null = null;
    db.insert
      .mockRejectedValueOnce(new Error("temporary insert failure"))
      .mockImplementationOnce(
        async (_table: string, data: DbRow) =>
          new Promise<{ id: string }>((resolve) => {
            db.rows.unshift({ id: "db-retry", created_at: new Date().toISOString(), ...data });
            resolveRetry = resolve;
          }),
      );

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getAllByRole("button", { name: /new note/i })[0]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const titleInput = screen.getByLabelText("Note title") as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "Retry draft" } });
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.change(titleInput, { target: { value: "Retry draft updated" } });
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.insert).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveRetry?.({ id: "db-retry" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.insert).toHaveBeenCalledTimes(2);
    expect(db.update).toHaveBeenCalledWith(
      "notes",
      "db-retry",
      expect.objectContaining({ title: "Retry draft updated" }),
    );
  });

  it("does not steal selection when a new note insert resolves", async () => {
    const db = installMatrixDb([
      {
        id: "n-1",
        title: "First note",
        content: "One",
        content_json: { type: "doc", content: [] },
        pinned: false,
        tags: "",
        updated_at: "2026-05-31T10:00:00.000Z",
      },
      {
        id: "n-2",
        title: "Second note",
        content: "Two",
        content_json: { type: "doc", content: [] },
        pinned: false,
        tags: "",
        updated_at: "2026-05-30T10:00:00.000Z",
      },
    ]);
    let resolveInsert: ((value: { id: string }) => void) | null = null;
    db.insert.mockImplementationOnce(
      async (_table: string, data: DbRow) =>
        new Promise<{ id: string }>((resolve) => {
          db.rows.unshift({ id: "db-new", created_at: new Date().toISOString(), ...data });
          resolveInsert = resolve;
        }),
    );

    render(<App />);
    await screen.findByText("First note");

    fireEvent.click(screen.getAllByRole("button", { name: /new note/i })[0]);
    fireEvent.click(screen.getByText("Second note"));

    await act(async () => {
      resolveInsert?.({ id: "db-new" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect((screen.getByLabelText("Note title") as HTMLInputElement).value).toBe("Second note");
  });

  it("deletes a pending create when its insert resolves after removal", async () => {
    const db = installMatrixDb([]);
    let resolveInsert: ((value: { id: string }) => void) | null = null;
    db.insert.mockImplementationOnce(
      async (_table: string, data: DbRow) =>
        new Promise<{ id: string }>((resolve) => {
          db.rows.unshift({ id: "db-new", created_at: new Date().toISOString(), ...data });
          resolveInsert = resolve;
        }),
    );

    render(<App />);
    await screen.findByText("No notes yet");

    fireEvent.click(screen.getAllByRole("button", { name: /new note/i })[0]);
    await screen.findByLabelText("Note title");
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    await act(async () => {
      resolveInsert?.({ id: "db-new" });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(db.delete).toHaveBeenCalledWith("notes", "db-new");
    });
    expect(db.rows.some((row) => row.id === "db-new")).toBe(false);
  });

  it("clears stored inline tags when the editor content removes them", async () => {
    const db = installMatrixDb([
      {
        id: "n-1",
        title: "Tagged",
        content: "Draft #old",
        content_json: { type: "doc", content: [] },
        pinned: false,
        tags: "old",
        updated_at: "2026-05-31T10:00:00.000Z",
      },
    ]);

    render(<App />);
    await screen.findByText("Tagged");

    fireEvent.click(screen.getByRole("button", { name: "Clear inline tag" }));

    await waitFor(() => {
      expect(db.update).toHaveBeenCalledWith(
        "notes",
        "n-1",
        expect.objectContaining({ content: "No tags left", tags: "" }),
      );
    });
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

  it("refreshes relative timestamps every minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T10:00:10.000Z"));
    installMatrixDb([
      {
        id: "n-1",
        title: "Fresh note",
        content: "body",
        content_json: { type: "doc", content: [] },
        pinned: false,
        tags: "",
        updated_at: "2026-05-31T10:00:00.000Z",
      },
    ]);

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("just now")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByText("1 min ago")).toBeTruthy();
  });
});
