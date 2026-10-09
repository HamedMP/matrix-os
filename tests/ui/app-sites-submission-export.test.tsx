// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteSubmissions } from "../../shell/src/components/app-sites/SiteSubmissions";
import type { useAppSite } from "../../shell/src/components/app-sites/use-app-site";
import { AppSitePanel } from "../../shell/src/components/app-sites/AppSitePanel";
import type { SiteClient, SiteSubmissionsPage } from "../../shell/src/lib/site-client";
const siteId = "11111111-1111-4111-8111-111111111111";
const row = { id: "44444444-4444-4444-8444-444444444444", siteId, formId: "rsvp", fields: { name: "Ada" }, createdAt: "2026-10-09T12:00:00Z" };
const nextCursor = "2026-10-09T12:00:00.000000Z|44444444-4444-4444-8444-444444444444";
const firstPage = { submissions: [row], nextCursor };
function client(submissions: SiteClient["submissions"], deleteSubmission: SiteClient["deleteSubmission"] = vi.fn(async () => undefined)): SiteClient {
  const site = { id: siteId, appSlug: "launch", title: "Launch", description: "", slug: null, url: `https://matrix.page/${siteId}`, revision: 1, status: "published" as const, activeVersion: null, versions: [], config: { data: {}, forms: [] } };
  return { get: vi.fn(async () => site), getConfig: vi.fn(async () => site.config), deploy: vi.fn(async () => site), update: vi.fn(async () => site), rollback: vi.fn(async () => site), unpublish: vi.fn(async () => site), submissions, deleteSubmission, exportSubmissions: vi.fn(async () => new Blob([JSON.stringify(firstPage)])) };
}
beforeEach(() => {
  vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:export"); static revokeObjectURL = vi.fn(); });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function openAndExport(api: SiteClient) {
  render(<AppSitePanel appSlug="launch" client={api} />);
  await screen.findByText("Your app is public.");
  fireEvent.click(screen.getByRole("button", { name: "Visitor submissions" }));
  await screen.findByText("Ada");
  fireEvent.click(screen.getByRole("button", { name: "Export this page" }));
  await screen.findByRole("button", { name: "Download again" });
}
describe("cached visitor export privacy", () => {
  it("clears a cached export immediately after successful erasure even if reload fails", async () => {
    let failReload!: (failure: Error) => void;
    const api = client(vi.fn().mockResolvedValueOnce(firstPage).mockImplementationOnce(() => new Promise((_resolve, reject) => { failReload = reject; })));
    await openAndExport(api);
    fireEvent.click(screen.getByRole("button", { name: "Delete submission" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await act(async () => {});
    expect(api.deleteSubmission).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Download again" })).toBeNull();
    await act(async () => failReload(new Error("Reload unavailable")));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Download again" })).toBeNull();
    expect(screen.queryByText("Ada")).toBeNull();
  });
  it("clears a cached export when navigating to another page before its request settles", async () => {
    let finish!: (page: SiteSubmissionsPage) => void;
    const api = client(vi.fn().mockResolvedValueOnce(firstPage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })));
    await openAndExport(api);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.queryByRole("button", { name: "Download again" })).toBeNull();
    await act(async () => finish({ submissions: [{ ...row, id: "55555555-5555-4555-8555-555555555555", fields: { name: "Grace" } }], nextCursor: null }));
    await screen.findByText("Grace");
    expect(api.submissions).toHaveBeenLastCalledWith("launch", nextCursor, expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: "Download again" })).toBeNull();
  });
  it("clears a cached export when refreshing even if the refresh fails", async () => {
    const api = client(vi.fn().mockResolvedValueOnce(firstPage).mockRejectedValueOnce(new Error("Refresh unavailable")));
    await openAndExport(api);
    fireEvent.click(screen.getByRole("button", { name: "Refresh submissions" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Download again" })).toBeNull();
  });
  it("does not recreate cached bytes or trigger a stale download when an export settles after a page change", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let finish!: (blob: Blob) => void;
    const api = client(vi.fn(async () => firstPage));
    api.exportSubmissions = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const state = {
      site: { id: siteId }, pending: false, submissions: firstPage, pageCursor: null,
      action: async <T,>(work: (signal: AbortSignal) => Promise<T>, success: (value: T) => void) => {
        try { success(await work(new AbortController().signal)); return true; }
        catch (failure: unknown) {
          console.warn("[site-export-test] action failed", failure instanceof Error ? "Error" : "UnknownError");
          return false;
        }
      },
      loadSubmissions: vi.fn(), removeSubmission: vi.fn(),
    } as unknown as ReturnType<typeof useAppSite>;
    const { rerender } = render(<SiteSubmissions appSlug="launch" client={api} state={state} />);
    fireEvent.click(screen.getByRole("button", { name: "Export this page" }));
    rerender(<SiteSubmissions appSlug="launch" client={api} state={{ ...state, pageCursor: nextCursor, submissions: { submissions: [{ ...row, id: "55555555-5555-4555-8555-555555555555", fields: { name: "Grace" } }], nextCursor: null } }} />);
    await act(async () => finish(new Blob(["deleted-or-previous-page-data"])));
    expect(screen.getByText("Grace")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download again" })).toBeNull();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith("[site-export-test] action failed", "Error");
  });
  it("revokes every temporary object URL after an export and after a repeated download", async () => {
    await openAndExport(client(vi.fn(async () => firstPage)));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:export");
    fireEvent.click(screen.getByRole("button", { name: "Download again" }));
    await act(async () => {});
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    cleanup();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

});
