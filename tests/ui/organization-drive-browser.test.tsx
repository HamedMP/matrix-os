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
 it("lets a contributor choose a new virtual upload folder with a validated relative path", () => {
  const change=vi.fn();render(<OrganizationDriveBrowser {...props} onFolderChange={change}/>);
  fireEvent.click(screen.getByRole("button",{name:"Choose upload folder"}));
  fireEvent.change(screen.getByLabelText("Upload folder path"),{target:{value:"reports/2027"}});
  fireEvent.click(screen.getByRole("button",{name:"Use folder"}));expect(change).toHaveBeenCalledWith("reports/2027");
  expect(screen.queryByRole("button",{name:"Use folder"})).toBeNull();
 });
 it("rejects traversal in an upload folder instead of applying it", () => {
  const change=vi.fn();render(<OrganizationDriveBrowser {...props} onFolderChange={change}/>);
  fireEvent.click(screen.getByRole("button",{name:"Choose upload folder"}));
  fireEvent.change(screen.getByLabelText("Upload folder path"),{target:{value:"../private"}});
  fireEvent.click(screen.getByRole("button",{name:"Use folder"}));expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toBeTruthy();
 });
 it("uses distinct row keys for a file and virtual folder at the same path", () => {
  const errors=vi.spyOn(console,"error").mockImplementation(()=>undefined);
  const view=render(<OrganizationDriveBrowser {...props} folder="a" files={[file("a/b"),file("a/b/c")]}/>);
  expect(screen.getByRole("button",{name:"Open folder b"})).toBeTruthy();
  expect(screen.getByRole("button",{name:"Download b"})).toBeTruthy();
  view.rerender(<OrganizationDriveBrowser {...props} folder="a" files={[file("a/b/c")]}/>);
  expect(screen.queryByRole("button",{name:"Download b"})).toBeNull();
  expect(errors.mock.calls.some(call=>call.some(value=>typeof value==="string"&&value.includes("same key")))).toBe(false);
  errors.mockRestore();
 });
 it("does not suggest a disabled Load more action after reaching the page limit", () => {
  render(<OrganizationDriveBrowser {...props} hasMore pageLimitReached onLoadMore={vi.fn()}/>);
  expect(screen.queryByText("Search covers loaded files. Load more to include additional files.")).toBeNull();
  expect(screen.getByText("Search covers loaded files. This view has reached its browsing limit.")).toBeTruthy();
 });

 it("leaves room for file names when validating upload folder bytes", () => {
  const change=vi.fn();render(<OrganizationDriveBrowser {...props} onFolderChange={change}/>);
  fireEvent.click(screen.getByRole("button",{name:"Choose upload folder"}));
  fireEvent.change(screen.getByLabelText("Upload folder path"),{target:{value:"é".repeat(273)}});
  fireEvent.click(screen.getByRole("button",{name:"Use folder"}));expect(change).not.toHaveBeenCalled();expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Upload folder path"),{target:{value:"é".repeat(272)}});
  fireEvent.click(screen.getByRole("button",{name:"Use folder"}));expect(change).toHaveBeenCalledWith("é".repeat(272));
 });

});
