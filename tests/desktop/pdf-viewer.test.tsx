// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PdfViewer from "@desktop/renderer/src/features/files/PdfViewer";
const { getDocument, getPage, destroy, paint, cancel } = vi.hoisted(() => ({ getDocument: vi.fn(), getPage: vi.fn(), destroy: vi.fn(), paint: vi.fn(), cancel: vi.fn() }));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument }));
vi.mock("@desktop/renderer/src/features/files/pdf-worker.ts?worker&url", () => ({ default: "/pdf.worker.mjs" }));
beforeEach(() => {
  vi.clearAllMocks();
  destroy.mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
  paint.mockReturnValue({ promise: Promise.resolve(), cancel });
  getPage.mockResolvedValue({ getViewport: ({ scale }: { scale: number }) => ({ width: 400 * scale, height: 600 * scale }), render: paint });
  getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 3, getPage }), destroy });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const blob = { arrayBuffer: async () => new ArrayBuffer(16), size: 16 } as Blob;

it("renders bounded PDF bytes with page and zoom controls, then destroys its worker", async () => {
  const { unmount } = render(<PdfViewer blob={blob} name="report.pdf" />);
  await waitFor(() => expect(paint).toHaveBeenCalled());
  expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ data: expect.any(Uint8Array), isEvalSupported: false, maxImageSize: 16_000_000 }));
  expect(screen.getByLabelText("Page number").getAttribute("max")).toBe("3");
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(getPage).toHaveBeenLastCalledWith(2));
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  await waitFor(() => expect(screen.getByText("125%")).toBeTruthy());
  unmount();
  expect(destroy).toHaveBeenCalled();
});
it("hides raw parser errors and provides a safe failure state", async () => {
  getDocument.mockReturnValue({ promise: Promise.reject(new Error("private PDF internals")), destroy });
  render(<PdfViewer blob={blob} name="broken.pdf" />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "PDF preview unavailable. Download the file to open it.");
  expect(screen.queryByText("private PDF internals")).toBeNull();
});
