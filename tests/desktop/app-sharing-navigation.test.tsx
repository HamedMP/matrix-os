// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopAppSiteButton } from "../../desktop/src/renderer/src/features/app-sites/DesktopAppSiteButton";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

const platform = vi.hoisted(() => ({ get: vi.fn(), close: vi.fn() }));
vi.mock("../../desktop/src/renderer/src/lib/collaboration", () => ({
  createDesktopCollaborationApi: () => platform,
  releaseDesktopCollaborationApi: () => platform.close(),
}));
vi.mock("../../desktop/src/renderer/src/features/app-sites/site-client", () => ({
  createDesktopSiteClient: () => ({ get: async () => null, getConfig: async () => ({ data: {}, forms: [] }) }),
}));
const build = {
  appId: "notes", catalogId: "30000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64), manifestVersion: "1.0.0", buildId: "b".repeat(64),
  manifestDigest: "c".repeat(64), schemaDigest: "d".repeat(64), assetDigest: "e".repeat(64),
  bridgeContractVersion: "matrix-app-bridge-v1", runtimeAbi: "matrix-runtime-v1",
};
const readiness = { readinessId: "40000000-0000-4000-8000-000000000001", build, status: "ready", revision: "2", checks: [{ code: "cleanup", status: "passed" }], verifiedAt: "2026-11-11T18:00:00.000Z" };
const activeShare = { scopeId: "10000000-0000-4000-8000-000000000001", organizationId: "org_matrix", owner: { actorId: "user_owner", displayName: "Owner" }, build, readinessId: readiness.readinessId, state: "active", shareRevision: "3", bindingRevision: "4", dataRevision: "5", createdAt: "2026-11-11T18:00:00.000Z", updatedAt: "2026-11-11T18:00:00.000Z" };
const MEMBERS = "/api/organizations/org_matrix/members?limit=100&include=imageUrl";
let share: typeof activeShare | null;
let shareError = false;
const gateway = {
  get: vi.fn(async (path: string) => {
    if (path.endsWith("/share")) { if (shareError) throw new Error("private password"); return share; }
    return path.endsWith("/readiness") ? readiness : { registrationIncarnation: build.registrationIncarnation };
  }),
  post: vi.fn(),
  delete: vi.fn(async () => { share = { ...activeShare, state: "stopped" }; return share; }),
};
const roster = [
  { actorId: "user_piers", displayName: "Piers Cole", imageUrl: "https://img.clerk.com/piers.png", role: "org:member", joinedAt: "2026-11-11T18:00:00.000Z" },
  { actorId: "user_owner", displayName: "Nima", role: "org:admin", joinedAt: "2026-11-11T18:00:00.000Z" },
];
beforeEach(() => {
  vi.clearAllMocks(); share = activeShare; shareError = false;
  useConnection.setState(useConnection.getInitialState(), true);
  useUi.setState(useUi.getInitialState(), true);
  useConnection.setState({ userId: "user_owner", organizationId: "org_matrix", organizationStatus: "member", api: { forRuntime: () => gateway } as never });
  platform.get.mockImplementation(async (path: string) => path === "/api/organizations"
    ? { complete: true, organizations: [{ organizationId: "org_matrix", name: "Matrix team" }, { organizationId: "org_other", name: "Other team" }] }
    : { members: roster });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function open() {
  render(<DesktopAppSiteButton appSlug="notes" />);
  fireEvent.click(screen.getByRole("button", { name: "Publish app" }));
  await screen.findByRole("dialog");
}

it("recognizes an existing share in a compact overview and navigates to the correct member roster", async () => {
  await open();
  const summary = await screen.findByRole("button", { name: /Shared with Matrix team/ });
  expect(summary.querySelector('[data-sharing-status="active"]')).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop sharing" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Invite" })).toBeTruthy();
  expect(platform.get).not.toHaveBeenCalledWith(MEMBERS);
  fireEvent.click(summary);
  const title = await screen.findByRole("heading", { name: "Organization sharing" });
  expect(title.tabIndex).toBe(-1);
  expect(document.activeElement).toBe(title);
  expect(screen.queryByRole("heading", { name: "Invite" })).toBeNull();
  const members = await screen.findByRole("list", { name: "Members of Matrix team" });
  expect(within(members).getByText("Piers Cole")).toBeTruthy();
  const photo = members.querySelector("img")!;
  expect(photo.getAttribute("src")).toBe("https://img.clerk.com/piers.png");
  expect(photo.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(within(members).getByText("Nima")).toBeTruthy();
  expect(within(members).getByText("N")).toBeTruthy();
  expect(platform.get).toHaveBeenCalledWith(MEMBERS);
  expect(screen.queryByText("Ready to share")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
  const region = screen.getByRole("region", { name: "Share with your org" });
  await within(region).findByText("Sharing stopped");
  expect(gateway.delete).toHaveBeenCalledWith("/api/collaboration/apps/notes/share", expect.objectContaining({ expectedShareRevision: "3", expectedBindingRevision: "4" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to sharing options" }));
  const back = await screen.findByRole("button", { name: /Share with your organization/ });
  await waitFor(() => expect(document.activeElement).toBe(back));
  expect(screen.getByRole("heading", { name: "Invite" })).toBeTruthy();
  expect(document.querySelector('[data-sharing-status="active"]')).toBeNull();
});

it("never shows an active indicator when the share read failed", async () => {
  shareError = true;
  await open();
  await screen.findByText("Sharing status unavailable");
  expect(document.querySelector('[data-sharing-status="active"]')).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Share with your organization/ }));
  expect(await screen.findByText("App sharing is unavailable. Try again.")).toBeTruthy();
  expect(screen.queryByText(/private password/)).toBeNull();
  expect((screen.getByRole("button", { name: "Share with your org" }) as HTMLButtonElement).disabled).toBe(true);
});

it("drops a confirmed active status when the follow-up share read fails", async () => {
  gateway.delete.mockImplementationOnce(async () => { shareError = true; throw new Error("conflict"); });
  await open();
  fireEvent.click(await screen.findByRole("button", { name: /Shared with Matrix team/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Stop sharing" }));
  const region = screen.getByRole("region", { name: "Share with your org" });
  await within(region).findByText("Sharing status unavailable");
  expect(document.querySelector('[data-sharing-status="active"]')).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop sharing" })).toBeNull();
});

it("labels a changed build as needing a check instead of active", async () => {
  share = { ...activeShare, state: "needs_recheck" };
  await open();
  await screen.findByText("Sharing needs a recheck");
  expect(document.querySelector('[data-sharing-status="active"]')).toBeNull();
  expect(document.querySelector('[data-sharing-status="needs_recheck"]')).toBeTruthy();
});

it("uses the shared organization even when another organization is selected", async () => {
  await open();
  fireEvent.click(await screen.findByRole("button", { name: /Shared with Matrix team/ }));
  await act(async () => { useConnection.setState({ organizationId: "org_other" }); });
  await screen.findByRole("list", { name: "Members of Matrix team" });
  expect(platform.get).not.toHaveBeenCalledWith(expect.stringContaining("/api/organizations/org_other/members"));
});

it("falls back to initials for a broken photo and retries an unavailable roster", async () => {
  let rosterReads = 0;
  platform.get.mockImplementation(async (path: string) => {
    if (path === "/api/organizations") return { complete: true, organizations: [{ organizationId: "org_matrix", name: "Matrix team" }] };
    if (++rosterReads <= 2) throw new Error("upstream secret");
    return { members: roster };
  });
  await open();
  fireEvent.click(await screen.findByRole("button", { name: /Shared with Matrix team/ }));
  expect(await screen.findByText("Members are unavailable.")).toBeTruthy();
  expect(screen.queryByText(/upstream secret/)).toBeNull();
  // A platform without the photo opt-in rejects the query once; the roster is then read without photos.
  expect(platform.get).toHaveBeenCalledWith("/api/organizations/org_matrix/members?limit=100");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  const members = await screen.findByRole("list", { name: "Members of Matrix team" });
  fireEvent.error(members.querySelector("img")!);
  expect(members.querySelector("img")).toBeNull();
  expect(within(members).getByText("PC")).toBeTruthy();
});

it("slides between views and only fades when reduced motion is requested", async () => {
  const animate = vi.fn(() => ({ cancel: vi.fn() }));
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  let reduce = false;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
  try {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: /Shared with Matrix team/ }));
    await screen.findByRole("heading", { name: "Organization sharing" });
    expect(animate).toHaveBeenLastCalledWith(
      [{ opacity: 0, transform: "translateX(8px)" }, { opacity: 1, transform: "translateX(0)" }],
      expect.objectContaining({ duration: 180 }),
    );
    reduce = true;
    fireEvent.click(screen.getByRole("button", { name: "Back to sharing options" }));
    await screen.findByRole("heading", { name: "Invite" });
    expect(animate).toHaveBeenLastCalledWith([{ opacity: 0 }, { opacity: 1 }], expect.objectContaining({ duration: 140 }));
  } finally {
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  }
});

it("keeps Escape dismissal and the native overlay lease from the details view", async () => {
  await open();
  expect(useUi.getState().rendererOverlayCount).toBe(1);
  fireEvent.click(await screen.findByRole("button", { name: /Shared with Matrix team/ }));
  fireEvent.keyDown(await screen.findByRole("heading", { name: "Organization sharing" }), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(useUi.getState().rendererOverlayCount).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Publish app" }));
  expect(await screen.findByRole("button", { name: /Shared with Matrix team/ })).toBeTruthy();
});

it("labels a roster that stops at the bounded page limit as incomplete", async () => {
  let page = 0;
  platform.get.mockImplementation(async (path: string) => {
    if (path === "/api/organizations") return { complete: true, organizations: [{ organizationId: "org_matrix", name: "Matrix team" }] };
    page += 1;
    return { members: [{ ...roster[0]!, actorId: `user_page${page}` }], nextCursor: `page${page}` };
  });
  await open();
  fireEvent.click(await screen.findByRole("button", { name: /Shared with Matrix team/ }));
  expect(await screen.findByText(/^Showing the first 20 members/)).toBeTruthy();
  expect(screen.getByText("20+")).toBeTruthy();
  expect(platform.get).toHaveBeenCalledTimes(21);
});
