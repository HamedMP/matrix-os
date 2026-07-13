// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeEditor } from "./mocks/tiptap-react";
import type { Note } from "../../home/apps/notes/src/notes-model";

const { default: RichEditor } = await import("../../home/apps/notes/src/RichEditor");

const note: Note = {
  id: "n-1",
  title: "Note",
  content: "",
  content_json: { type: "doc", content: [] },
  preview: "",
  pinned: false,
  tags: [],
  created_at: "2026-05-31T10:00:00.000Z",
  updated_at: "2026-05-31T10:00:00.000Z",
};

describe("RichEditor", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("prevents the slash trigger from being inserted into the document", () => {
    render(<RichEditor note={note} onChange={vi.fn()} />);

    const wrap = screen.getByTestId("editor-content").parentElement!;
    const event = fireEvent.keyDown(wrap, { key: "/" });

    expect(event).toBe(false);
    expect(screen.getByRole("menu", { name: "Insert block" })).toBeTruthy();
  });

  it("does not reset content when a temporary note id is promoted", () => {
    const tempNote = { ...note, id: "note-temp" };
    const { rerender } = render(<RichEditor note={tempNote} onChange={vi.fn()} />);
    fakeEditor.commands.setContent.mockClear();

    rerender(<RichEditor note={{ ...tempNote, id: "db-note" }} onChange={vi.fn()} />);

    expect(fakeEditor.commands.setContent).not.toHaveBeenCalled();
  });
});
