// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileDropZone, LocalFileError } from "../../../home/apps/_shared/office-ui";

afterEach(cleanup);

function transfer(types: string[], files: File[] = []) {
  return { types, files, dropEffect: "none" };
}

function renderZone() {
  const onFile = vi.fn();
  const onReject = vi.fn();
  render(
    <>
      <div data-testid="doc">Document</div>
      <FileDropZone accept={[".csv", ".xlsx"]} onFile={onFile} onReject={onReject} />
    </>,
  );
  return { onFile, onReject };
}

describe("FileDropZone", () => {
  it("shows an overlay while a file is dragged over the window and hides it on leave", () => {
    renderZone();
    expect(screen.queryByText("Drop a file to open it")).toBeNull();
    fireEvent.dragEnter(screen.getByTestId("doc"), { dataTransfer: transfer(["Files"]) });
    expect(screen.getByText("Drop a file to open it")).toBeTruthy();
    expect(screen.getByText(".csv or .xlsx, up to 10 MB")).toBeTruthy();
    fireEvent.dragLeave(screen.getByTestId("doc"), { dataTransfer: transfer(["Files"]) });
    expect(screen.queryByText("Drop a file to open it")).toBeNull();
  });

  it("ignores drags that start inside the document", () => {
    renderZone();
    const doc = screen.getByTestId("doc");
    const enter = fireEvent.dragEnter(doc, { dataTransfer: transfer(["text/plain"]) });
    const over = fireEvent.dragOver(doc, { dataTransfer: transfer(["text/plain"]) });
    expect(enter).toBe(true);
    expect(over).toBe(true);
    expect(screen.queryByText("Drop a file to open it")).toBeNull();
  });

  it("accepts a dropped file and reports its bytes", async () => {
    const { onFile, onReject } = renderZone();
    const doc = screen.getByTestId("doc");
    fireEvent.dragEnter(doc, { dataTransfer: transfer(["Files"]) });
    const over = fireEvent.dragOver(doc, { dataTransfer: transfer(["Files"]) });
    expect(over).toBe(false);
    const dropped = fireEvent.drop(doc, { dataTransfer: transfer(["Files"], [new File(["a,b"], "sales.csv")]) });
    expect(dropped).toBe(false);
    expect(screen.queryByText("Drop a file to open it")).toBeNull();
    await waitFor(() => expect(onFile).toHaveBeenCalledTimes(1));
    expect(onFile.mock.calls[0][0].name).toBe("sales.csv");
    expect(onReject).not.toHaveBeenCalled();
  });

  it("rejects a dropped file of the wrong type with a typed error", async () => {
    const { onFile, onReject } = renderZone();
    fireEvent.drop(screen.getByTestId("doc"), { dataTransfer: transfer(["Files"], [new File(["x"], "photo.png")]) });
    await waitFor(() => expect(onReject).toHaveBeenCalledTimes(1));
    expect(onReject.mock.calls[0][0]).toBeInstanceOf(LocalFileError);
    expect(onReject.mock.calls[0][0].code).toBe("wrong-type");
    expect(onFile).not.toHaveBeenCalled();
  });

  it("hides the overlay when drag events stop arriving", () => {
    vi.useFakeTimers();
    try {
      renderZone();
      fireEvent.dragEnter(screen.getByTestId("doc"), { dataTransfer: transfer(["Files"]) });
      expect(screen.getByText("Drop a file to open it")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.queryByText("Drop a file to open it")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing while disabled", () => {
    const onFile = vi.fn();
    render(<FileDropZone accept={[".csv"]} onFile={onFile} onReject={vi.fn()} disabled />);
    const event = fireEvent.dragOver(document.body, { dataTransfer: transfer(["Files"]) });
    expect(event).toBe(true);
    expect(screen.queryByText("Drop a file to open it")).toBeNull();
  });
});
