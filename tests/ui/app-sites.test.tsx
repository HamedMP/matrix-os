// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppSitePanel } from "../../shell/src/components/app-sites/AppSitePanel";
import type { SiteClient } from "../../shell/src/lib/site-client";

const published = { id: "11111111-1111-4111-8111-111111111111", appSlug: "launch", title: "Launch", description: "Join us", slug: "matrix-launch", url: "https://matrix.page/matrix-launch", revision: 1, status: "published" as const, activeVersion: "22222222-2222-4222-8222-222222222222", versions: [{ id: "22222222-2222-4222-8222-222222222222", createdAt: "2026-10-09T12:00:00Z" }, { id: "33333333-3333-4333-8333-333333333333", createdAt: "2026-10-08T12:00:00Z" }], config: { data: {}, forms: [] } };
function client(overrides: Partial<SiteClient> = {}): SiteClient {
  return { getConfig: vi.fn(async () => ({ data: {}, forms: [] })), get: vi.fn(async () => published), deploy: vi.fn(async () => published), update: vi.fn(async () => published), rollback: vi.fn(async () => published), unpublish: vi.fn(async () => ({ ...published, status: "unpublished" as const })), submissions: vi.fn(async () => ({ submissions: [], nextCursor: null })), exportSubmissions: vi.fn(async () => new Blob(["[]"])), deleteSubmission: vi.fn(async () => undefined), ...overrides };
}
afterEach(cleanup);
describe("shared app publishing", () => {
  it("loads publication and requires preview before deploying draft changes", async () => {
    const api = client({ get: vi.fn(async () => null) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    expect(screen.getByText("Loading publication…")).toBeTruthy();
    await screen.findByText("This app is private.");
    const deploy = screen.getByRole("button", { name: "Publish app" });
    expect(deploy).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Review deployment" }));
    expect(await screen.findByText(/Only declared public data and forms/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("I reviewed this deployment"));
    fireEvent.click(deploy);
    await screen.findByText("Published successfully.");
    expect(api.deploy).toHaveBeenCalledWith("launch", expect.objectContaining({ title: "launch", reviewedConfig: { data: {}, forms: [] } }), expect.any(AbortSignal));
  });
  it("preserves live state and hides server details on failed unpublish", async () => {
    const api = client({ unpublish: vi.fn(async () => { throw new Error("postgres://secret.internal/password"); }) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("Your app is public.");
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unpublish" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not complete this action. Please try again.");
    expect(screen.getByText("Your app is public.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm unpublish" })).toBeTruthy();
  });
  it("provides version rollback and retained visitor submissions with export and delete", async () => {
    const api = client({ submissions: vi.fn().mockResolvedValueOnce({ submissions: [{ id: "44444444-4444-4444-8444-444444444444", siteId: published.id, formId: "rsvp", fields: { name: "Ada" }, createdAt: "2026-10-09T12:00:00Z" }], nextCursor: null }).mockResolvedValue({ submissions: [], nextCursor: null }) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("Your app is public.");
    fireEvent.click(screen.getByRole("button", { name: /Restore version/ }));
    await screen.findByText("Version restored.");
    expect(api.rollback).toHaveBeenCalledWith("launch", { versionId: published.versions[1].id, baseRevision: 1 }, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Visitor submissions" }));
    await screen.findByText(/Ada/);
    expect(screen.getByRole("button", { name: "Export this page" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete submission" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await screen.findByText("No visitor submissions yet.");
    expect(api.deleteSubmission).toHaveBeenCalledWith("launch", "44444444-4444-4444-8444-444444444444", expect.any(AbortSignal));
  });
  it("ignores late requests when the selected app changes", async () => {
    let finish!: (value: typeof published) => void;
    const api = client({ get: vi.fn((app) => app === "launch" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(null)) });
    const { rerender } = render(<AppSitePanel appSlug="launch" client={api} />);
    rerender(<AppSitePanel appSlug="other" client={api} />);
    await screen.findByText("This app is private.");
    await act(async () => finish(published));
    expect(screen.queryByText("Your app is public.")).toBeNull();
    expect(screen.getByLabelText("Title")).toHaveProperty("value", "other");
  });
  it("handles load failures with a retry without claiming that the app is private", async () => {
    const api = client({ get: vi.fn(async () => { throw new Error("private internal host"); }) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Publishing is unavailable. Please try again.");
    expect(screen.queryByText("This app is private.")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
  it("clears the previous runtime publication before a replacement client resolves for the same app", async () => {
    let finish!: (value: typeof published) => void;
    const original = client();
    const replacement = client({ get: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
    const { rerender } = render(<AppSitePanel appSlug="launch" client={original} />);
    await screen.findByText("Your app is public.");
    rerender(<AppSitePanel appSlug="launch" client={replacement} />);
    expect(screen.getByText("Loading publication…")).toBeTruthy();
    expect(screen.queryByText("Your app is public.")).toBeNull();
    expect(screen.queryByText(published.url)).toBeNull();
    await act(async () => finish({ ...published, title: "Replacement runtime", description: "Fresh details" }));
    await screen.findByText("Your app is public.");
    expect(screen.getByLabelText("Title")).toHaveProperty("value", "Replacement runtime");
  });
  it("keeps a submission visible after delete failure and catches export failures", async () => {
    const api = client({
      submissions: vi.fn(async () => ({ submissions: [{ id: "44444444-4444-4444-8444-444444444444", siteId: published.id, formId: "rsvp", fields: { name: "Ada" }, createdAt: "2026-10-09T12:00:00Z" }], nextCursor: "2026-10-09T12:00:00.000000Z|44444444-4444-4444-8444-444444444444" })),
      deleteSubmission: vi.fn(async () => { throw new Error("private database down"); }),
      exportSubmissions: vi.fn(async () => { throw new Error("filesystem /private/path"); }),
    });
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("Your app is public.");
    fireEvent.click(screen.getByRole("button", { name: "Visitor submissions" }));
    await screen.findByText("Ada");
    fireEvent.click(screen.getByRole("button", { name: "Delete submission" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await screen.findByRole("alert");
    expect(screen.getByText("Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export this page" }));
    expect((await screen.findByRole("alert")).textContent).not.toContain("private");
    expect(api.exportSubmissions).toHaveBeenCalledWith("launch", null, expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "Next page" })).toBeTruthy();
  });
  it("invalidates review when metadata changes and fails closed on config failure", async () => {
    const api = client({ get: vi.fn(async () => null), getConfig: vi.fn(async () => ({ data: { event: "Launch" }, forms: [] })) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("This app is private.");
    fireEvent.click(screen.getByRole("button", { name: "Review deployment" }));
    await screen.findByText(/Only declared public data/);
    fireEvent.click(screen.getByLabelText("I reviewed this deployment"));
    expect(screen.getByRole("button", { name: "Publish app" })).toHaveProperty("disabled", false);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "New launch" } });
    expect(screen.getByRole("button", { name: "Publish app" })).toHaveProperty("disabled", true);
    vi.mocked(api.getConfig).mockRejectedValueOnce(new Error("internal manifest path"));
    fireEvent.click(screen.getByRole("button", { name: "Review deployment" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Publish app" })).toHaveProperty("disabled", true);
  });

  it("initializes metadata from an asynchronously loaded publication", async () => {
    let resolve!: (site: typeof published) => void;
    const api = client({ get: vi.fn(() => new Promise(done => { resolve = done; })) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    expect(screen.getByLabelText("Title")).toHaveProperty("value", "launch");
    await act(async () => resolve({ ...published, title: "Launch guidance", description: "Start here", slug: "getting-started" }));
    await screen.findByText("Your app is public.");
    expect(screen.getByLabelText("Title")).toHaveProperty("value", "Launch guidance");
    expect(screen.getByLabelText("Description")).toHaveProperty("value", "Start here");
    expect(screen.getByLabelText("Friendly path (optional)")).toHaveProperty("value", "getting-started");
  });
  it("requires a new deployment review after a version is restored", async () => {
    const restored = { ...published, revision: 2, activeVersion: published.versions[1].id, title: "Restored launch" };
    const api = client({ rollback: vi.fn(async () => restored) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("Your app is public.");
    fireEvent.click(screen.getByRole("button", { name: "Review deployment" }));
    await screen.findByText(/Only declared public data/);
    fireEvent.click(screen.getByLabelText("I reviewed this deployment"));
    expect(screen.getByRole("button", { name: "Publish update" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: /Restore version/ }));
    await screen.findByText("Version restored.");
    expect(screen.getByLabelText("Title")).toHaveProperty("value", "Restored launch");
    expect(screen.queryByLabelText("I reviewed this deployment")).toBeNull();
    expect(screen.getByRole("button", { name: "Publish update" })).toHaveProperty("disabled", true);
  });
  it("reloads the current submission page after deletion to refill its visible records", async () => {
    const row = { id: "44444444-4444-4444-8444-444444444444", siteId: published.id, formId: "rsvp", fields: { name: "Ada" }, createdAt: "2026-10-09T12:00:00Z" };
    const api = client({ submissions: vi.fn().mockResolvedValueOnce({ submissions: [row], nextCursor: "2026-10-09T12:00:00.000000Z|44444444-4444-4444-8444-444444444444" }).mockResolvedValueOnce({ submissions: [{ ...row, id: "55555555-5555-4555-8555-555555555555", fields: { name: "Previously next page" } }], nextCursor: null }) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("Your app is public."); fireEvent.click(screen.getByRole("button", { name: "Visitor submissions" }));
    await screen.findByText("Ada"); fireEvent.click(screen.getByRole("button", { name: "Delete submission" })); fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await screen.findByText("Previously next page");
    expect(api.submissions).toHaveBeenNthCalledWith(2, "launch", null, expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("invalidates the visible page and removes a confirmed deletion if the page reload fails", async () => {
    const row = { id: "44444444-4444-4444-8444-444444444444", siteId: published.id, formId: "rsvp", fields: { name: "Ada" }, createdAt: "2026-10-09T12:00:00Z" };
    const api = client({ submissions: vi.fn().mockResolvedValueOnce({ submissions: [row], nextCursor: "2026-10-09T12:00:00.000000Z|44444444-4444-4444-8444-444444444444" }).mockRejectedValueOnce(new Error("private database path")) });
    render(<AppSitePanel appSlug="launch" client={api} />);
    await screen.findByText("Your app is public."); fireEvent.click(screen.getByRole("button", { name: "Visitor submissions" }));
    await screen.findByText("Ada"); fireEvent.click(screen.getByRole("button", { name: "Delete submission" })); fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Ada")).toBeNull(); expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
    expect(screen.queryByText("private database path")).toBeNull();
    expect(screen.getByRole("button", { name: "Export this page" })).toHaveProperty("disabled", true);
  });

});
