// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PreviewPairBanner } from "@desktop/renderer/src/features/preview/PreviewPairBanner";
import { previewPairManifestFixture } from "../platform/preview-pair-test-support.js";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), select: vi.fn(), state: { status: "signed-in", userId: "user_pair_owner", handle: "", organizationId: null as string | null },
  listing: { state: "loaded", complete: true, organizations: [{ organizationId: "org_pair_fixture", name: "Collaboration test" }] } }));
vi.mock("@desktop/renderer/src/lib/operator", () => ({ invoke: mocks.invoke }));
vi.mock("@desktop/renderer/src/stores/connection", () => ({ useConnection: Object.assign((select: any) => select({ ...mocks.state, selectOrganization: mocks.select }), { getState: () => mocks.state }) }));
vi.mock("@desktop/renderer/src/features/collaboration/useDesktopOrganizations", () => ({ useDesktopOrganizations: () => mocks.listing }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function setup() {
  const f = previewPairManifestFixture(); mocks.state.handle = f.members.owner.handle; mocks.state.organizationId = null;
  mocks.invoke.mockResolvedValue({ role: "owner", pr: f.pr, sourceSha: f.sourceSha, handle: f.members.owner.handle, organizationId: f.organizationId });
  return f;
}
it("shows role and pinned source before login and uses actual connection/completeness for the selected organization", async () => {
  const f = setup(); render(<PreviewPairBanner />);
  expect((await screen.findByRole("status")).textContent).toContain(`Owner · PR #${f.pr}`);
  expect(screen.getByRole("status").textContent).toContain(f.sourceSha.slice(0, 12));
  expect(screen.getByRole("status").textContent).toContain(f.members.owner.handle);
  await waitFor(() => expect(mocks.select).toHaveBeenCalledWith(f.organizationId));
});
it("leaves normal apps without a preview banner or organization selection", async () => {
  setup(); mocks.invoke.mockResolvedValue(null); render(<PreviewPairBanner />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalled()); expect(screen.queryByRole("status")).toBeNull(); expect(mocks.select).not.toHaveBeenCalled();
});
it("does not select an organization absent from the current verified listing", async () => {
  setup(); mocks.listing.organizations = []; render(<PreviewPairBanner />);
  expect((await screen.findByRole("status")).textContent).toContain("Organization unavailable"); expect(mocks.select).not.toHaveBeenCalled();
  mocks.listing.organizations = [{ organizationId: "org_pair_fixture", name: "Collaboration test" }];
});
