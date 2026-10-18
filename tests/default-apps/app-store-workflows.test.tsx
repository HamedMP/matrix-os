// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ListingDetail from "../../home/apps/app-gallery/src/store/ListingDetail";
import DraftDetail from "../../home/apps/app-gallery/src/store/DraftDetail";
import Publish from "../../home/apps/app-gallery/src/store/Publish";
import ReviewDetail from "../../home/apps/app-gallery/src/store/ReviewDetail";
import { createStoreClient } from "../../home/apps/app-gallery/src/store-model";
import { draft, draftSummary, id, listing, reviewDetail } from "./app-store-fixtures";
afterEach(() => { cleanup(); sessionStorage.clear(); });
function bridge(route: (url: string, body?: any) => unknown) { return { gatewayFetch: vi.fn(async (url: string, init?: { body?: string }) => route(url, init?.body ? JSON.parse(init.body) : undefined)), openApp: vi.fn() }; }
const status = { enabled: true, reviewer: false, signingKeys: [], generalizer: { available: true, label: "Owner AI", accessSourceId: "provider1" } };
async function consentInstall() { fireEvent.click(await screen.findByRole("button", { name: /Get app|Update app/ })); fireEvent.click(screen.getByLabelText(/I agree to these capabilities/)); fireEvent.click(screen.getByRole("button", { name: "Install source" })); }
describe("store workflow recovery", () => {
  it("resumes a local build after reopening and opens only the installed app", async () => {
    let installed = false;
    const b = bridge(url => { if (url.includes("/installs/")) { installed = true; return { id, status: "installed", appSlug: "sample-notes", launchPath: "apps/sample-notes" }; } if (url.endsWith("/install")) return { id, status: "building" }; return { ...listing, local: { installed, updateAvailable: false, ...(installed ? { launchPath: "apps/sample-notes" } : {}) } }; });
    const client = createStoreClient(b); const first = render(<ListingDetail client={client} slug={listing.slug} onBack={vi.fn()} />);
    await consentInstall(); await screen.findByText(/Building on your Matrix computer/); first.unmount();
    render(<ListingDetail client={client} slug={listing.slug} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open app" }));
    await waitFor(() => expect(b.openApp).toHaveBeenCalledWith("Sample Notes", "apps/sample-notes"));
    expect(sessionStorage.getItem("matrix-store-pending-install")).toBeNull();
  });
  it("keeps the old app available on local build failure and never leaks backend errors", async () => {
    const b = bridge(url => url.endsWith("/install") ? { id, status: "failed", error: "unavailable" } : { ...listing, local: { installed: true, updateAvailable: true, launchPath: "apps/sample-notes" } });
    render(<ListingDetail client={createStoreClient(b)} slug={listing.slug} onBack={vi.fn()} />);
    await consentInstall(); expect((await screen.findByRole("alert")).textContent).toMatch(/unavailable/);
    expect(screen.getByRole("button", { name: "Open app" })).toBeTruthy();
  });
  it("preserves an existing rating if the server rejects a change", async () => {
    const b = bridge(url => { if (url.endsWith("/rating")) throw new Error("Postgres /private/customer"); return { ...listing, myRating: 4, local: { installed: true, updateAvailable: false } }; });
    render(<ListingDetail client={createStoreClient(b)} slug={listing.slug} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Rate 5 stars" }));
    expect((await screen.findByRole("alert")).textContent).not.toContain("Postgres");
    expect(screen.getByRole("button", { name: "Rate 4 stars" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("requires fresh source consent when the selected AI access source changes", async () => {
    const b = bridge(url => url.endsWith("publishable-apps") ? { apps: [{ slug: "my-notes", name: "My notes", eligible: true }] } : { drafts: [] });
    const client = createStoreClient(b); const { rerender } = render(<Publish client={client} status={status} />);
    fireEvent.change(await screen.findByLabelText("App to publish"), { target: { value: "my-notes" } });
    fireEvent.click(screen.getByLabelText(/I agree to send scrubbed source/));
    expect((screen.getByRole("button", { name: "Prepare shareable copy" }) as HTMLButtonElement).disabled).toBe(false);
    rerender(<Publish client={client} status={{ ...status, generalizer: { ...status.generalizer, accessSourceId: "provider2" } }} />);
    expect((screen.getByRole("button", { name: "Prepare shareable copy" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("invalidates submission consent when listing changes and saves before submit", async () => {
    let value = structuredClone(draft);
    const b = bridge((url, body) => { if (url.endsWith("/listing")) { value = { ...value, listing: body }; return value; } if (url.endsWith("/submit")) return { ...draftSummary(), status: "submitted" }; return value; });
    render(<DraftDetail client={createStoreClient(b)} id={id} onBack={vi.fn()} />);
    await screen.findByLabelText("Publishing license"); fireEvent.change(screen.getByLabelText("Publishing license"), { target: { value: "MIT" } }); fireEvent.click(screen.getByLabelText(/I reviewed the changes/));
    expect((screen.getByRole("button", { name: "Submit for review" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Tagline"), { target: { value: "A new description" } });
    expect((screen.getByRole("button", { name: "Submit for review" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save listing" })); await screen.findByText(/Listing saved/);
    fireEvent.click(screen.getByLabelText(/I reviewed the changes/)); fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    await waitFor(() => expect(b.gatewayFetch.mock.calls.some(call => call[0].endsWith("/submit"))).toBe(true));
  });
  it("publishes reviewed source directly and requires a reason before suspension", async () => {
    let value = structuredClone(reviewDetail);
    const b = bridge((url, body) => { if (url.endsWith("/decision")) { value = { ...value, item: { ...value.item, status: "published" }, listing: { ...value.listing, status: "live", currentVersion: "1.0.0" } }; return value.item; } if (url.endsWith("/action")) return { error: "forbidden" }; return value; });
    render(<ReviewDetail client={createStoreClient(b)} id={id} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve source" })); fireEvent.click(screen.getByRole("button", { name: "Confirm decision" }));
    await screen.findByText(/Approved source is published/); await waitFor(() => expect((screen.getByRole("button", { name: "Suspend" }) as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
    expect((screen.getByRole("button", { name: "Confirm decision" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reviewer message"), { target: { value: "Investigating unsafe access" } }); fireEvent.click(screen.getByRole("button", { name: "Confirm decision" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/do not have access/);
  });
});
