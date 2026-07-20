// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/win-sticky-notes/src/App";
import { MAX_NOTES, NOTES_KEY } from "../../home/apps/win-sticky-notes/src/sticky-notes-model";

function installMatrixDataBridge(data = new Map<string, unknown>()) {
  const bridge = {
    readData: vi.fn(async (key: string) => data.get(key) ?? null),
    writeData: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
  Object.defineProperty(window, "MatrixOS", { configurable: true, value: bridge });
  return bridge;
}

const savedNotes = [
  { id: "n-1", text: "Buy milk\nAnd eggs", color: "yellow", createdAt: 100, updatedAt: 200 },
  { id: "n-2", text: "Call the dentist", color: "blue", createdAt: 50, updatedAt: 300 },
];

describe("Sticky Notes (win11) app", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
  });

  it("loads saved notes into the list, most recent first, and selects the newest", async () => {
    installMatrixDataBridge(new Map([[NOTES_KEY, savedNotes]]));
    render(<App />);

    const items = await screen.findAllByRole("button", { name: /buy milk|call the dentist/i });
    expect(items[0].textContent).toContain("Call the dentist");
    expect(items[1].textContent).toContain("Buy milk");

    const editor = screen.getByLabelText(/note text/i) as HTMLTextAreaElement;
    expect(editor.value).toBe("Call the dentist");
  });

  it("shows the empty state when there are no notes", async () => {
    installMatrixDataBridge();
    render(<App />);

    expect(await screen.findByText(/no note selected/i)).toBeTruthy();
    expect(screen.getByText(/no notes yet/i)).toBeTruthy();
  });

  it("does not autosave an empty list after the initial bridge read fails", async () => {
    const bridge = installMatrixDataBridge();
    bridge.readData.mockRejectedValue(new Error("gateway unavailable"));
    render(<App />);

    expect(await screen.findByText(/no note selected/i)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(bridge.writeData).not.toHaveBeenCalled();
  });

  it("keeps note creation disabled until the initial bridge read settles", async () => {
    let resolveRead: (value: unknown) => void = () => undefined;
    const pendingRead = new Promise<unknown>((resolve) => {
      resolveRead = resolve;
    });
    const bridge = installMatrixDataBridge();
    bridge.readData.mockReturnValue(pendingRead);
    render(<App />);

    const newNoteButtons = screen.getAllByRole("button", { name: /new note/i });
    expect(newNoteButtons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);

    resolveRead([]);
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /new note/i }).every((button) => !(button as HTMLButtonElement).disabled),
      ).toBe(true);
    });
  });

  it("creates a note and persists edits immediately", async () => {
    const bridge = installMatrixDataBridge();
    render(<App />);

    await screen.findByText(/no note selected/i);
    fireEvent.click(screen.getAllByRole("button", { name: /new note/i })[0]);

    const editor = screen.getByLabelText(/note text/i) as HTMLTextAreaElement;
    expect(editor.value).toBe("");
    const list = screen.getByRole("complementary", { name: /notes list/i });
    expect(await within(list).findByText("New note")).toBeTruthy();

    fireEvent.change(editor, { target: { value: "Ship the win11 build" } });

    await waitFor(() => {
      expect(bridge.writeData).toHaveBeenCalledWith(
        NOTES_KEY,
        expect.arrayContaining([expect.objectContaining({ text: "Ship the win11 build" })]),
      );
    });

    // The new note shows up in the list with its snippet.
    expect(within(list).getByText("Ship the win11 build")).toBeTruthy();
  });

  it("refuses to create notes beyond MAX_NOTES instead of dropping the oldest on reload", async () => {
    const full = Array.from({ length: MAX_NOTES }, (_, i) => ({
      id: `n-${i}`,
      text: `note ${i}`,
      color: "yellow",
      createdAt: i,
      updatedAt: i,
    }));
    const bridge = installMatrixDataBridge(new Map([[NOTES_KEY, full]]));
    render(<App />);

    const list = await screen.findByRole("complementary", { name: /notes list/i });
    await within(list).findByText(`note ${MAX_NOTES - 1}`);
    fireEvent.click(screen.getAllByRole("button", { name: /new note/i })[0]);

    // Still exactly MAX_NOTES notes, and nothing new is written.
    expect(within(list).getAllByRole("button").length).toBe(MAX_NOTES);
    expect(bridge.writeData).not.toHaveBeenCalled();
  });

  it("starts the latest save before iframe removal can bypass React cleanup", async () => {
    const bridge = installMatrixDataBridge();
    render(<App />);

    await screen.findByText(/no note selected/i);
    fireEvent.click(screen.getAllByRole("button", { name: /new note/i })[0]);
    const editor = screen.getByLabelText(/note text/i) as HTMLTextAreaElement;
    bridge.writeData.mockClear();
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "last-second edit" } });
    await act(async () => {
      await Promise.resolve();
    });

    expect(bridge.writeData).toHaveBeenCalledWith(
      NOTES_KEY,
      expect.arrayContaining([expect.objectContaining({ text: "last-second edit" })]),
    );
  });

  it("switches the selected note from the list", async () => {
    installMatrixDataBridge(new Map([[NOTES_KEY, savedNotes]]));
    render(<App />);

    const item = (await screen.findAllByRole("button", { name: /buy milk/i }))[0];
    fireEvent.click(item);

    const editor = screen.getByLabelText(/note text/i) as HTMLTextAreaElement;
    expect(editor.value).toBe("Buy milk\nAnd eggs");
  });

  it("changes the note color and persists it", async () => {
    const bridge = installMatrixDataBridge(new Map([[NOTES_KEY, savedNotes]]));
    render(<App />);

    const pink = await screen.findByRole("radio", { name: /pink/i });
    fireEvent.click(pink);

    await waitFor(
      () => {
        expect(bridge.writeData).toHaveBeenCalledWith(
          NOTES_KEY,
          expect.arrayContaining([expect.objectContaining({ id: "n-2", color: "pink" })]),
        );
      },
      { timeout: 3000 },
    );
  });

  it("deletes the selected note and selects the next one", async () => {
    const bridge = installMatrixDataBridge(new Map([[NOTES_KEY, savedNotes]]));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /delete note/i }));

    // n-2 (selected, most recent) is gone; n-1 takes its place in the editor.
    const editor = screen.getByLabelText(/note text/i) as HTMLTextAreaElement;
    expect(editor.value).toBe("Buy milk\nAnd eggs");
    expect(screen.queryByRole("button", { name: /call the dentist/i })).toBeNull();

    await waitFor(
      () => {
        expect(bridge.writeData).toHaveBeenCalledWith(
          NOTES_KEY,
          expect.not.arrayContaining([expect.objectContaining({ id: "n-2" })]),
        );
      },
      { timeout: 3000 },
    );
  });

  it("works in-memory only when the bridge is absent", async () => {
    render(<App />);

    await screen.findByText(/no note selected/i);
    fireEvent.click(screen.getAllByRole("button", { name: /new note/i })[0]);
    const editor = screen.getByLabelText(/note text/i) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "Session-only note" } });

    const list = screen.getByRole("complementary", { name: /notes list/i });
    await within(list).findByText("Session-only note");
    expect((editor as HTMLTextAreaElement).value).toBe("Session-only note");
  });
});
