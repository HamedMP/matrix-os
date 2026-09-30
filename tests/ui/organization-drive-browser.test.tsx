// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationDriveBrowser } from "../../packages/ui/src/organization-drive/OrganizationDriveBrowser";
import type { OrganizationDriveFile } from "@matrix-os/contracts";
const file = (path: string, size = 2048): OrganizationDriveFile => ({ id: path, organizationId: "org_example", path, size, version: 1, sha256: "a".repeat(64), updatedAt: "2026-09-30T12:00:00.000Z", updatedBy: "user_example" });
const files = [file("README.md"), file("reports/2026/annual.md"), file("reports/summary.md"), file("design/logo.png")];
const props = { name: "Authority", files, usedBytes: 8192, reservedBytes: 0, quotaBytes: 1_000_000_000_000, busy: false, canUpload: true, folder: "", onFolderChange: vi.fn(), onDownload: vi.fn() };
afterEach(cleanup);
describe("shared organization drive browser", () => {
 it("shows navigable folders, file metadata and scope-aware breadcrumbs", () => {
  const change = vi.fn(); const view = render(<OrganizationDriveBrowser {...props} onFolderChange={change}/>);
  expect(screen.getByRole("button", { name: "Open folder reports" })).toBeTruthy();
  expect(screen.queryByText("annual.md")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open folder reports" }));
  expect(change).toHaveBeenCalledWith("reports");
  view.rerender(<OrganizationDriveBrowser {...props} folder="reports" onFolderChange={change}/>);
  expect(screen.getByRole("navigation", { name: "Drive folders" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open folder 2026" })).toBeTruthy();
  expect(screen.getByText("summary.md")).toBeTruthy();
  expect(screen.getByText(/2\.0 KB/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Authority drive root" }));
  expect(change).toHaveBeenLastCalledWith("");
 });
 it("searches loaded paths and explains incomplete results", () => {
  render(<OrganizationDriveBrowser {...props} hasMore onLoadMore={vi.fn()}/>);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search drive files" }), { target: { value: "annual" } });
  expect(screen.getByText("annual.md")).toBeTruthy();
  expect(screen.queryByText("README.md")).toBeNull();
  expect(screen.getByText("Search covers loaded files. Load more to include additional files.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Load more files" })).toBeTruthy();
 });
 it("keeps viewer transfers read-only and disables actions during transfers", () => {
  const download = vi.fn(); const view=render(<OrganizationDriveBrowser {...props} canUpload={false} onDownload={download}/>);
  expect(screen.getByText(/View access/)).toBeTruthy();
  expect(screen.queryByLabelText("Upload files")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Download README.md" }));
  expect(download).toHaveBeenCalledWith(files[0]);
  view.rerender(<OrganizationDriveBrowser {...props} busy onDownload={download}/>);
  expect((screen.getByRole("button", { name: "Download README.md" }) as HTMLButtonElement).disabled).toBe(true);
 });
 it("shows a useful empty-folder state and upload destination", () => {
  render(<OrganizationDriveBrowser {...props} files={[]} folder="reports" uploadControl={<button>Upload files</button>}/>);
  expect(screen.getByText("No files in this folder yet.")).toBeTruthy();
  expect(screen.getByText("Uploads go to reports.")).toBeTruthy();
 });
});
