// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FilePreviewActions } from "../../packages/ui/src/files/FilePreviewActions";
afterEach(cleanup);
it("offers image actions only on right click with safe retry and completion feedback", async () => {
  const download = vi.fn(async () => {});
  const copy = vi.fn().mockRejectedValueOnce(new Error("private failure")).mockResolvedValue(undefined);
  render(<FilePreviewActions name="chart.png" onDownload={download} onCopyImage={copy}><img alt="Chart" src="blob:chart" /></FilePreviewActions>);
  expect(screen.queryByRole("button", { name: /Download|Copy image/ })).toBeNull();
  expect(screen.queryByRole("menuitem")).toBeNull();
  fireEvent.contextMenu(screen.getByRole("img", { name: "Chart" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Download chart.png" }));
  expect(download).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "Copy image chart.png" }).hasAttribute("data-disabled")).toBe(false));
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy image chart.png" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not copy image. Try again.");
  expect(screen.queryByText("private failure")).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy image chart.png" }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "Image copied");
});
it("disables duplicate actions while a native download is pending", async () => {
  const download = vi.fn();
  render(<FilePreviewActions name="chart.png" pending onDownload={download}><img alt="Chart" src="blob:chart" /></FilePreviewActions>);
  fireEvent.contextMenu(screen.getByRole("img", { name: "Chart" }));
  const item = await screen.findByRole("menuitem", { name: "Download chart.png" });
  expect(item.hasAttribute("data-disabled")).toBe(true);
  fireEvent.click(item);
  expect(download).not.toHaveBeenCalled();
});
