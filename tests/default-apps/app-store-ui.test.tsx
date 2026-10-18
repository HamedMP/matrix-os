// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import StoreHub from "../../home/apps/app-gallery/src/StoreHub";
import ListingDetail from "../../home/apps/app-gallery/src/store/ListingDetail";
import Publish from "../../home/apps/app-gallery/src/store/Publish";
import Review from "../../home/apps/app-gallery/src/store/Review";
import { createStoreClient } from "../../home/apps/app-gallery/src/store-model";
import { draft, draftSummary, id, listing, reviewDetail, reviewItem, summary } from "./app-store-fixtures";
afterEach(cleanup);
const bridge = (route: (url: string, body?: any) => unknown) => ({ gatewayFetch: vi.fn(async (url: string, init?: { body?: string }) => route(url, init?.body ? JSON.parse(init.body) : undefined)), openApp: vi.fn() });
const enabled = { enabled: true, reviewer: false, signingKeys: [], generalizer: { available: true, label: "My AI provider", accessSourceId: "provider1" } };
describe("publish and review", () => {
  it("requires separate provider consent before AI preparation", async () => {
    const b = bridge(url => url.endsWith("publishable-apps") ? { apps: [{ slug: "my-notes", name: "My notes", eligible: true }] } : url.endsWith("/drafts") ? { drafts: [] } : draft);
    render(<Publish client={createStoreClient(b)} status={enabled} />);
    fireEvent.change(await screen.findByLabelText("App to publish"), { target: { value: "my-notes" } });
    const prepare = screen.getByRole("button", { name: "Prepare shareable copy" }) as HTMLButtonElement;
    expect(prepare.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I agree to send scrubbed source/)); fireEvent.click(prepare);
    await waitFor(() => expect(b.gatewayFetch.mock.calls.some(call => call[0].endsWith("/drafts") && call[1]?.body?.includes("provider1"))).toBe(true));
  });
  it("shows reports/diffs and final license/consent gate", async () => {
    const b = bridge(url => url.endsWith("publishable-apps") ? { apps: [] } : url.endsWith("/drafts") ? { drafts: [draftSummary()] } : url.includes("/diff?") ? { path: "src/App.tsx", change: "modified", binary: false, truncated: false, before: "private", after: "generic" } : draft);
    render(<Publish client={createStoreClient(b)} status={enabled} />);
    fireEvent.click(await screen.findByRole("button", { name: /My notes/ }));
    expect(await screen.findByText(/Removed owner email/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "src/App.tsx" })); expect(await screen.findByText("generic")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Submit for review" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("review requires a message for changes and handles CAS conflict", async () => {
    const b = bridge(url => url.includes("/queue") ? { items: [reviewItem] } : url.endsWith("/decision") ? { error: "conflict" } : reviewDetail);
    render(<Review client={createStoreClient(b)} />); fireEvent.click(await screen.findByRole("button", { name: /Sample Notes/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Request changes" }));
    const confirm = screen.getByRole("button", { name: "Confirm decision" }) as HTMLButtonElement; expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reviewer message"), { target: { value: "Please remove owner details." } }); fireEvent.click(confirm);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/changed/));
  });
});

it("shows the Review tab only for the authenticated staff status", async () => {
  const regular = bridge(() => enabled);
  const staff = bridge(() => ({ ...enabled, reviewer: true }));
  const { rerender } = render(<StoreHub bridge={regular} />);
  await screen.findByRole("button", { name: "Publish" });
  expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  rerender(<StoreHub bridge={staff} />);
  expect(await screen.findByRole("button", { name: "Review" })).toBeTruthy();
});
