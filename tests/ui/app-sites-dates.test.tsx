// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppSitePanel } from "../../shell/src/components/app-sites/AppSitePanel";
import type { SiteClient } from "../../shell/src/lib/site-client";

afterEach(cleanup);
it("labels publication and visitor timestamps consistently in UTC", async () => {
  const date = "2026-10-09T12:00:00Z";
  const site = { id: "11111111-1111-4111-8111-111111111111", appSlug: "launch", title: "Launch", description: "", slug: null, url: "https://matrix.page/11111111-1111-4111-8111-111111111111", revision: 1, status: "published", activeVersion: "22222222-2222-4222-8222-222222222222", versions: [{ id: "22222222-2222-4222-8222-222222222222", createdAt: date }], config: { data: {}, forms: [] } };
  const api = { get: vi.fn(async () => site), submissions: vi.fn(async () => ({ submissions: [{ id: "44444444-4444-4444-8444-444444444444", siteId: site.id, formId: "rsvp", fields: {}, createdAt: date }], nextCursor: null })) } as unknown as SiteClient;
  render(<AppSitePanel appSlug="launch" client={api} />);
  await screen.findByText("Your app is public.");
  expect(screen.getByText(/Oct 9, 2026, 12:00 PM UTC/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Visitor submissions" }));
  await screen.findByText("rsvp · Oct 9, 2026, 12:00 PM UTC");
});
