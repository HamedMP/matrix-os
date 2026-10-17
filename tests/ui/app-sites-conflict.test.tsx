// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppSitePanel } from "../../shell/src/components/app-sites/AppSitePanel";
import { SiteClientError, type SiteClient } from "../../shell/src/lib/site-client";

const site = { id: "11111111-1111-4111-8111-111111111111", appSlug: "launch", title: "Launch", description: "Old details", slug: null, url: "https://matrix.page/11111111-1111-4111-8111-111111111111", revision: 1, status: "published" as const, activeVersion: null, versions: [], config: { data: {}, forms: [] } };
function client(overrides: Partial<SiteClient> = {}): SiteClient {
  return { get: vi.fn(async () => site), getConfig: vi.fn(async () => site.config), update: vi.fn(async () => { throw new SiteClientError(409); }), deploy: vi.fn(async () => ({ ...site, revision: 3 })), ...overrides } as unknown as SiteClient;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function conflict(api: SiteClient) {
  render(<AppSitePanel appSlug="launch" client={api} />);
  await screen.findByText("Your app is public.");
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My launch" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "My draft details" } });
  fireEvent.change(screen.getByLabelText("Friendly path (optional)"), { target: { value: "my-launch" } });
  fireEvent.click(screen.getByRole("button", { name: "Review deployment" }));
  fireEvent.click(await screen.findByLabelText("I reviewed this deployment"));
  fireEvent.click(screen.getByRole("button", { name: "Save URL and details" }));
  await screen.findByRole("alert");
}
it("recovers the latest revision deliberately, preserves all draft metadata, and requires another review", async () => {
  let resolve!: (record: typeof site) => void;
  const api = client({ get: vi.fn().mockResolvedValueOnce(site).mockImplementationOnce(() => new Promise(done => { resolve = done; })) });
  await conflict(api);
  fireEvent.click(screen.getByRole("button", { name: "Refresh publication" }));
  expect(screen.queryByLabelText("I reviewed this deployment")).toBeNull();
  await act(async () => resolve({ ...site, revision: 2, title: "Another editor", description: "Other details", slug: "other-launch" }));
  expect(screen.getByLabelText("Title")).toHaveProperty("value", "My launch");
  expect(screen.getByLabelText("Description")).toHaveProperty("value", "My draft details");
  expect(screen.getByLabelText("Friendly path (optional)")).toHaveProperty("value", "my-launch");
  expect(screen.getByRole("button", { name: "Publish update" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Review deployment" }));
  fireEvent.click(await screen.findByLabelText("I reviewed this deployment"));
  fireEvent.click(screen.getByRole("button", { name: "Publish update" }));
  await screen.findByText("Published successfully.");
  expect(api.deploy).toHaveBeenCalledWith("launch", { title: "My launch", description: "My draft details", slug: "my-launch", baseRevision: 2, reviewedConfig: site.config }, expect.any(AbortSignal));
});
it("keeps recovery retryable and draft metadata intact when publication refresh fails", async () => {
  const api = client({ get: vi.fn().mockResolvedValueOnce(site).mockRejectedValueOnce(new Error("private database failure")) });
  await conflict(api);
  fireEvent.click(screen.getByRole("button", { name: "Refresh publication" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Refresh publication" })).toHaveProperty("disabled", false);
  expect(screen.getByLabelText("Title")).toHaveProperty("value", "My launch");
  expect(screen.queryByLabelText("I reviewed this deployment")).toBeNull();
  expect(screen.getByRole("button", { name: "Publish update" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("alert").textContent).not.toContain("private");
});
it("ignores a late conflict recovery after the runtime client changes", async () => {
  let resolve!: (record: typeof site) => void;
  const api = client({ get: vi.fn().mockResolvedValueOnce(site).mockImplementationOnce(() => new Promise(done => { resolve = done; })) });
  const { rerender } = render(<AppSitePanel appSlug="launch" client={api} />);
  await screen.findByText("Your app is public.");
  fireEvent.click(screen.getByRole("button", { name: "Save URL and details" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Refresh publication" }));
  rerender(<AppSitePanel appSlug="launch" client={client({ get: vi.fn(async () => ({ ...site, title: "Replacement runtime" })) })} />);
  await screen.findByText("Your app is public.");
  await act(async () => resolve({ ...site, revision: 2, title: "Stale recovery" }));
  expect(screen.getByLabelText("Title")).toHaveProperty("value", "Replacement runtime");
  expect(screen.queryByText("Publication refreshed. Your draft details were kept. Review deployment before publishing.")).toBeNull();
});
it("does not treat a failed declaration read as a publication mutation conflict", async () => {
  render(<AppSitePanel appSlug="launch" client={client({ getConfig: vi.fn(async () => { throw new SiteClientError(409); }) })} />);
  await screen.findByText("Your app is public.");
  fireEvent.click(screen.getByRole("button", { name: "Review deployment" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Refresh publication" })).toBeNull();
  expect(screen.getByRole("button", { name: "Save URL and details" })).toHaveProperty("disabled", false);
});
