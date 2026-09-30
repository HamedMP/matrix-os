// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationDrivesNavigation } from "../../packages/ui/src/organization-drive/OrganizationDrivesNavigation";
const scopeId = "00000000-0000-4000-8000-000000000001";
const organizationId = "org_example";
function api() {return {get: vi.fn(async (path: string) => path === "/api/organizations" ? {organizations: [{organizationId, name: "Authority"}]} : {items: path.startsWith("/api/collaboration/shared") ? [{scopeId, runtimeId: "runtime_owner", ownerId: "user_owner", kind: "folder", authorityGeneration: 1, organizationId, status: "accepted"}] : []}), direct: {request: vi.fn(async (_scope: string, _method: string, path: string) => path.endsWith("/drive") ? {organizationId, scopeId, usedBytes: 0, reservedBytes: 0, quotaBytes: 1_000_000_000_000, files: []} : {id: scopeId, ownerId: "user_owner", kind: "folder", resourceId: "folder_example", organizationId, membershipMode: "direct", lifecycle: "shared", revision: "1", authEpoch: "1", authorityGeneration: "1", role: "viewer", capabilities: {read: true, discuss: false, manageMembers: false, requestAi: false}})}};}
afterEach(cleanup);
describe("organization drives in Chat navigation", () => {
 it("discovers authorized drives and opens the exact scope", async () => {
  const open=vi.fn(); render(<OrganizationDrivesNavigation api={api() as never} onOpen={open}/>);
  const row=await screen.findByRole("button", {name: "Open Authority drive"}); fireEvent.click(row);
  expect(open).toHaveBeenCalledWith(expect.objectContaining({scopeId, organizationId, name: "Authority"}));
 });
 it("clears previous member content when the account client changes", async () => {
  const view=render(<OrganizationDrivesNavigation api={api() as never} onOpen={vi.fn()}/>);
  await screen.findByRole("button", {name: "Open Authority drive"});
  view.rerender(<OrganizationDrivesNavigation api={null} onOpen={vi.fn()}/>);
  await waitFor(() => expect(screen.queryByRole("button", {name: "Open Authority drive"})).toBeNull());
 });
});
