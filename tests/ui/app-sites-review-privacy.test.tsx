// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppSitePanel } from "../../shell/src/components/app-sites/AppSitePanel";
import type { SiteClient } from "../../shell/src/lib/site-client";

const config = { data: { guidance: "Private draft guidance" }, forms: [] };
const site = { id: "11111111-1111-4111-8111-111111111111", appSlug: "launch", title: "Launch", description: "", slug: null, url: "https://matrix.page/11111111-1111-4111-8111-111111111111", revision: 1, status: "published", activeVersion: null, versions: [], config };
function client(getConfig: SiteClient["getConfig"]): SiteClient {
  return { get: vi.fn(async () => site), getConfig, submissions: vi.fn(async () => ({ submissions: [{ id: "44444444-4444-4444-8444-444444444444", siteId: site.id, formId: "rsvp", fields: { email: "private@example.com" }, createdAt: "2026-10-09T12:00:00Z" }], nextCursor: null })) } as unknown as SiteClient;
}
afterEach(cleanup);
it("excludes visitor responses and unpublished public declarations from replay capture", async () => {
  render(<AppSitePanel appSlug="launch" client={client(vi.fn(async () => config))} />);
  await screen.findByText("Your app is public.");
  fireEvent.click(screen.getByRole("button", { name: "Visitor submissions" }));
  const visitor = await screen.findByText("private@example.com");
  expect(visitor.closest(".ph-no-capture")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review deployment" }));
  const draft = await screen.findByText(/"Private draft guidance"/);
  expect(draft.closest(".ph-no-capture")).not.toBeNull();
});
it.each(["success", "failure"])("discards approval immediately when review reloads, including %s", async outcome => {
  let resolve!: (value: typeof config) => void;
  let reject!: (failure: Error) => void;
  const getConfig = vi.fn().mockResolvedValueOnce(config).mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
  render(<AppSitePanel appSlug="launch" client={client(getConfig)} />);
  await screen.findByText("Your app is public.");
  fireEvent.click(screen.getByRole("button", { name: "Review deployment" }));
  fireEvent.click(await screen.findByLabelText("I reviewed this deployment"));
  expect(screen.getByRole("button", { name: "Publish update" })).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: "Review deployment" }));
  expect(screen.queryByLabelText("I reviewed this deployment")).toBeNull();
  expect(screen.queryByText(/"Private draft guidance"/)).toBeNull();
  await act(async () => {
    if (outcome === "success") resolve({ data: { guidance: "Changed draft guidance" }, forms: [] });
    else reject(new Error("private manifest path"));
  });
  expect(screen.getByRole("button", { name: "Publish update" })).toHaveProperty("disabled", true);
  if (outcome === "success") {
    expect(screen.getByLabelText("I reviewed this deployment")).toHaveProperty("checked", false);
    fireEvent.click(screen.getByLabelText("I reviewed this deployment"));
    expect(screen.getByRole("button", { name: "Publish update" })).toHaveProperty("disabled", false);
  } else {
    expect(screen.queryByLabelText("I reviewed this deployment")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
  }
});
