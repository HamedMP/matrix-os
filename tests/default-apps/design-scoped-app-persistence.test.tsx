// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StickiesApp from "../../home/apps/stickies/src/App";
import { parseBestTimes } from "../../home/apps/winxp-minesweeper/src/minesweeper-model";
import WidgetsApp from "../../home/apps/widgets/src/App";

const originalMatrixOs = window.MatrixOS;

describe("design-scoped app persistence", () => {
  const readData = vi.fn();
  const writeData = vi.fn();

  beforeEach(() => {
    readData.mockReset();
    writeData.mockReset();
    readData.mockResolvedValue(null);
    writeData.mockResolvedValue(undefined);
    window.MatrixOS = { readData, writeData };
  });

  afterEach(() => {
    vi.useRealTimers();
    window.MatrixOS = originalMatrixOs;
  });

  it("restores Windows XP Minesweeper best times from string-backed bridge storage", () => {
    expect(parseBestTimes('{"beginner":42,"intermediate":91}')).toEqual({
      beginner: 42,
      intermediate: 91,
    });
  });

  it("preserves an intentionally empty macOS Stickies board from bridge storage", async () => {
    readData.mockResolvedValueOnce("[]");

    render(<StickiesApp />);

    expect(await screen.findByText(/No stickies yet/)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Sticky note" })).toBeNull();
  });

  it("does not allow a new macOS Sticky before persisted notes finish loading", async () => {
    let finishRead: ((value: unknown) => void) | undefined;
    readData.mockImplementationOnce(() => new Promise((resolve) => {
      finishRead = resolve;
    }));

    render(<StickiesApp />);

    const addButton = screen.getByRole("button", { name: "New note" }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);

    finishRead?.("[]");
    await waitFor(() => expect(addButton.disabled).toBe(false));
    expect(screen.queryByRole("textbox", { name: "Sticky note" })).toBeNull();
  });

  it("persists macOS Sticky edits immediately so iframe removal cannot lose them", async () => {
    render(<StickiesApp />);
    const note = await screen.findByRole("textbox", { name: "Sticky note" });
    vi.useFakeTimers();

    fireEvent.change(note, { target: { value: "Keep this Mac note" } });
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeData).toHaveBeenCalledTimes(1);
    expect(writeData).toHaveBeenCalledWith(
      "macos-stickies/notes",
      expect.arrayContaining([expect.objectContaining({ text: "Keep this Mac note" })]),
    );
  });

  it("clamps macOS Sticky text to the same limit used during restore", async () => {
    render(<StickiesApp />);
    const note = await screen.findByRole("textbox", { name: "Sticky note" }) as HTMLTextAreaElement;

    fireEvent.change(note, { target: { value: "x".repeat(20_005) } });

    expect(note.value).toHaveLength(20_000);
    expect(writeData).toHaveBeenLastCalledWith(
      "macos-stickies/notes",
      expect.arrayContaining([expect.objectContaining({ text: "x".repeat(20_000) })]),
    );
  });

  it("does not accept macOS Stickies beyond the persisted restore cap", async () => {
    readData.mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => ({
      id: `note-${index}`,
      x: 24,
      y: 24,
      z: index + 1,
      text: "",
      color: "yellow",
    })));

    render(<StickiesApp />);

    const addButton = await screen.findByRole("button", { name: "New note" }) as HTMLButtonElement;
    await waitFor(() => expect(addButton.disabled).toBe(true));
    fireEvent.click(addButton);
    expect(writeData).not.toHaveBeenCalled();
  });

  it("persists Windows Widgets edits immediately so iframe removal cannot lose them", async () => {
    render(<WidgetsApp />);
    const note = await screen.findByRole("textbox", { name: "Notes" });
    vi.useFakeTimers();

    fireEvent.change(note, { target: { value: "Keep this Windows note" } });
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeData).toHaveBeenCalledTimes(1);
    expect(writeData).toHaveBeenCalledWith("win11-widgets/notes", "Keep this Windows note");
  });

  it("does not allow a Windows Widgets edit before persisted text finishes loading", async () => {
    let finishRead: ((value: unknown) => void) | undefined;
    readData.mockImplementationOnce(() => new Promise((resolve) => {
      finishRead = resolve;
    }));

    render(<WidgetsApp />);

    const note = screen.getByRole("textbox", { name: "Notes" }) as HTMLTextAreaElement;
    expect(note.disabled).toBe(true);

    finishRead?.("Saved before opening");
    await waitFor(() => expect(note.disabled).toBe(false));
    expect(note.value).toBe("Saved before opening");
  });
});
