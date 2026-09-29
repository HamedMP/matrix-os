// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FilePreviewActions } from "../../packages/ui/src/files/FilePreviewActions";
afterEach(cleanup);
it("offers download and copy image with completion and safe retry feedback", async () => {
  const download = vi.fn(async () => {});
  const copy = vi.fn().mockRejectedValueOnce(new Error("private failure")).mockResolvedValue(undefined);
  render(<FilePreviewActions name="chart.png" onDownload={download} onCopyImage={copy} />);
  fireEvent.click(screen.getByRole("button", { name: "Download chart.png" }));
  expect(download).toHaveBeenCalledTimes(1);
  await screen.findByRole("button", { name: "Copy image chart.png" });
  fireEvent.click(screen.getByRole("button", { name: "Copy image chart.png" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not copy image. Try again.");
  expect(screen.queryByText("private failure")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy image chart.png" }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "Image copied");
});
