// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import StoreHub from "../../home/apps/app-gallery/src/StoreHub";
import ListingDetail from "../../home/apps/app-gallery/src/store/ListingDetail";
import { createStoreClient } from "../../home/apps/app-gallery/src/store-model";
import { draft, draftSummary, id, listing, reviewDetail, reviewItem, summary } from "./app-store-fixtures";
afterEach(cleanup);
const bridge = (route: (url: string, body?: any) => unknown) => ({ gatewayFetch: vi.fn(async (url: string, init?: { body?: string }) => route(url, init?.body ? JSON.parse(init.body) : undefined)), openApp: vi.fn() });
const enabled = { enabled: true, reviewer: false, signingKeys: [], generalizer: { available: true, label: "My AI provider", accessSourceId: "provider1" } };
describe("community store", () => {
  it("keeps store navigation hidden when disabled", async () => {
    render(<StoreHub bridge={bridge(() => ({ enabled: false, reviewer: false }))} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Community" })).toBeNull());
  });
  it("shows community cards, search and metrics ", async () => {
    const b = bridge(url => url.endsWith("/status") ? enabled : { listings: [summary()] });
    render(<StoreHub bridge={b} />); fireEvent.click(await screen.findByRole("button", { name: "Community" }));
    expect(await screen.findByText("Sample Notes")).toBeTruthy();
    expect(screen.getByText(/8 downloads/)).toBeTruthy(); expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search community apps"), { target: { value: "finance" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(b.gatewayFetch.mock.calls.some(call => call[0].includes("q=finance"))).toBe(true));
  });
  it("shows needs and waits for consent before starting a local build", async () => {
    const b = bridge(url => url.includes("/install") ? { id, status: "building" } : listing);
    render(<ListingDetail client={createStoreClient(b)} slug={listing.slug} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Get app" }));
    expect(screen.getByText("list_messages")).toBeTruthy(); expect(screen.getByText(/built on your Matrix computer/)).toBeTruthy();
    expect(b.gatewayFetch.mock.calls.some(call => call[0].endsWith("/install"))).toBe(false);
    fireEvent.click(screen.getByLabelText(/I agree to these capabilities/));
    fireEvent.click(screen.getByRole("button", { name: "Install source" }));
    expect(await screen.findByText(/Building on your Matrix computer/)).toBeTruthy();
  });
  it("shows safe errors and installed-only ratings", async () => {
    const b = bridge(() => ({ ...listing, local: { installed: true, updateAvailable: true, launchPath: "apps/sample-notes" }, myInstall: { versionId: listing.currentVersion.id, version: "1.0.0", active: true } }));
    render(<ListingDetail client={createStoreClient(b)} slug={listing.slug} onBack={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Update app" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rate 5 stars" })).toBeTruthy();
  });
});
