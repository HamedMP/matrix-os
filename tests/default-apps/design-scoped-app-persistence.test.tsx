// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StickiesApp from "../../home/apps/stickies/src/App";
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
    window.MatrixOS = originalMatrixOs;
  });

  it("flushes the latest macOS Sticky edit when the app closes during the debounce", async () => {
    const view = render(<StickiesApp />);
    const note = await screen.findByRole("textbox", { name: "Sticky note" });

    fireEvent.change(note, { target: { value: "Keep this Mac note" } });
    view.unmount();

    await waitFor(() => expect(writeData).toHaveBeenCalledTimes(1));
    expect(writeData).toHaveBeenCalledWith(
      "macos-stickies/notes",
      expect.arrayContaining([expect.objectContaining({ text: "Keep this Mac note" })]),
    );
  });

  it("flushes the latest Windows Widgets note when the app closes during the debounce", async () => {
    const view = render(<WidgetsApp />);
    const note = await screen.findByRole("textbox", { name: "Notes" });

    fireEvent.change(note, { target: { value: "Keep this Windows note" } });
    view.unmount();

    await waitFor(() => expect(writeData).toHaveBeenCalledTimes(1));
    expect(writeData).toHaveBeenCalledWith("win11-widgets/notes", "Keep this Windows note");
  });
});
