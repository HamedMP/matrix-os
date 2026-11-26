// @vitest-environment jsdom
import React, { useMemo } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  SiteEmailInvitationCreateRequestSchema, SiteEmailInvitationMutationRequestSchema,
  SiteMetadataSchema, SitePublishRequestSchema, type SiteEmailInvitationSummary, type SiteRecord,
} from "@matrix-os/contracts";
import { SharePanel, createSiteEmailInvitationAdapter, useShareController } from "../../packages/ui/src/share/index";
import { createSiteClient, SiteClientError, type SiteTransport } from "../../shell/src/lib/site-client";

// Real UI/controller -> live adapter -> production client/DTO parsers. Only the
// HTTP service is a fixture; database authority and Clerk domains are separate lanes.
const APP = "sales-crm";
const SITE_ID = "11111111-1111-4111-8111-111111111111";
const INVITE_ID = "44444444-4444-4444-8444-444444444444";
const site: SiteRecord = {
  id: SITE_ID, appSlug: APP, title: "Sales CRM", description: "", slug: null,
  url: `https://matrix.page/${SITE_ID}`, revision: 3, status: "published", accessMode: "private_email",
  activeVersion: "22222222-2222-4222-8222-222222222222", versions: [], config: { data: {}, forms: [] },
  capabilities: { privateEmailInvitations: true },
};
const invitation = (overrides: Partial<SiteEmailInvitationSummary> = {}): SiteEmailInvitationSummary => ({
  id: INVITE_ID, emailAddress: "sara@example.com", state: "pending", deliveryState: "suppressed",
  generation: 1, revision: 0, issuedAt: "2026-11-01T00:00:00.000Z", expiresAt: "2030-11-08T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z", ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(initial: SiteRecord | null = site, enabled = true, initialPeople: SiteEmailInvitationSummary[] = []) {
  const state = { site: initial, people: initialPeople, enabled, next: null as string | null, readiness: null as Record<string, unknown> | null };
  const get = vi.fn(async (path: string): Promise<unknown> => {
    if (path.endsWith("/email-invitation-capabilities")) return state.readiness ?? { privateEmailInvitations: state.enabled, emailDelivery: "none" };
    if (path.includes("/invitations?")) return { invitations: state.people, nextCursor: state.next, siteRevision: state.site!.revision };
    if (path.includes("/access-links?")) return { links: [], nextCursor: null };
    if (path.endsWith("/manifest")) return { manifest: { publishing: { data: {}, forms: [] } } };
    return state.site;
  });
  const patch = vi.fn(async (_path: string, raw: unknown): Promise<unknown> => {
    const value = SiteMetadataSchema.parse(raw);
    expect(value.baseRevision).toBe(state.site!.revision);
    const { baseRevision: _revision, ...metadata } = value;
    state.site = { ...state.site!, ...metadata, revision: state.site!.revision + 1 };
    return state.site;
  });
  const post = vi.fn(async (path: string, raw: unknown): Promise<unknown> => {
    if (path.endsWith("/site")) {
      const value = SitePublishRequestSchema.parse(raw);
      expect(value.accessMode).toBe("private_email");
      state.site = { ...site, revision: (state.site?.revision ?? 0) + 1 };
      return state.site;
    }
    if (path.endsWith("/invitations")) {
      const value = SiteEmailInvitationCreateRequestSchema.parse(raw);
      expect(value.baseRevision).toBe(state.site!.revision);
      state.people = [invitation({ emailAddress: value.emailAddresses[0] })];
    } else {
      const value = SiteEmailInvitationMutationRequestSchema.parse(raw);
      expect(value.baseRevision).toBe(state.site!.revision);
      expect(value.invitationRevision).toBe(state.people[0].revision);
      state.people = [invitation({ revision: state.people[0].revision + 1 })];
    }
    state.site = { ...state.site!, revision: state.site!.revision + 1 };
    return path.endsWith("/invitations")
      ? { results: [{ inputIndex: 0, outcome: "queued", invitation: state.people[0] }], siteRevision: state.site.revision }
      : { invitation: state.people[0], siteRevision: state.site.revision };
  });
  const remove = vi.fn(async (_path: string, raw: unknown): Promise<unknown> => {
    const value = SiteEmailInvitationMutationRequestSchema.parse(raw);
    expect(value.baseRevision).toBe(state.site!.revision);
    expect(value.invitationRevision).toBe(state.people[0].revision);
    state.people = [invitation({ state: "revoked", revision: value.invitationRevision + 1 })];
    state.site = { ...state.site!, revision: state.site!.revision + 1 };
    return { invitation: state.people[0], siteRevision: state.site.revision };
  });
  const transport = { get, post, patch, delete: remove, getBlob: vi.fn(), getText: vi.fn() } as unknown as SiteTransport;
  return { state, get, post, patch, remove, api: createSiteClient(transport) };
}
function Host({ api }: { api: ReturnType<typeof createSiteClient> }) {
  const emailInvites = useMemo(() => createSiteEmailInvitationAdapter(api), [api]);
  const share = useShareController({ appSlug: APP, appName: "Sales CRM", client: api, emailInvites });
  return <>
    <output data-testid="revision">{share.site?.revision}</output>
    <output data-testid="site-title">{share.site?.title}</output>
    <button disabled={share.operation !== null || share.loading} onClick={() => void share.saveDetails({ title: "Saved", description: "", slug: null })}>Save details</button>
    <SharePanel share={share} appSlug={APP} appName="Sales CRM" client={api} ownerInitial="N" onClose={vi.fn()} />
  </>;
}
const ready = () => waitFor(() => expect(screen.queryByRole("status", { name: "Loading" })).toBeNull());
const openPrivate = () => fireEvent.mouseDown(screen.getByRole("tab", { name: /Private/ }), { button: 0 });
async function invite() {
  openPrivate();
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "sara@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("hides invitations for an unpublished app when the server capability is false", async () => {
  const f = fixture(null, false);
  render(<Host api={f.api} />); await ready();
  expect(screen.queryByRole("tab", { name: /Private/ })).toBeNull();
  expect(screen.queryByLabelText("Email address")).toBeNull();
  expect(f.post).not.toHaveBeenCalled();
  expect(f.get.mock.calls.some(([path]) => path.includes("/invitations?"))).toBe(false);
});

it("publishes the first invitation directly as private_email and carries its revision into later saves", async () => {
  const f = fixture(null);
  render(<Host api={f.api} />); await ready(); await invite();
  expect(await screen.findByText("sara@example.com")).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId("revision").textContent).toBe("2"));
  expect(f.post.mock.calls[0][0]).toBe(`/api/apps/${APP}/site`);
  expect(f.patch).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Save details" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Save details" }));
  await waitFor(() => expect(screen.getByTestId("revision").textContent).toBe("3"));
  expect(f.patch.mock.calls[0][1]).toMatchObject({ accessMode: "private_email", baseRevision: 2 });
});

it("requires confirmation before atomically replacing one-time links with email access", async () => {
  const f = fixture({ ...site, accessMode: "private_link" });
  render(<Host api={f.api} />); await ready(); await invite();
  expect(f.patch).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog").textContent).toContain("Existing one-time links stop working");
  fireEvent.click(screen.getByRole("button", { name: "Make invite-only" }));
  expect(await screen.findByText("sara@example.com")).toBeTruthy();
  expect(f.patch).toHaveBeenCalledTimes(1);
  expect(f.patch.mock.calls[0][1]).toMatchObject({ accessMode: "private_email", baseRevision: 3 });
  expect(f.remove).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByTestId("revision").textContent).toBe("5"));
});

it("lets the owner stop a live invite-only site without making it public", async () => {
  const f = fixture(site, true, [invitation()]);
  f.remove.mockImplementation(async () => { f.state.site = { ...site, status: "unpublished", revision: 4 }; return f.state.site; });
  render(<Host api={f.api} />); await ready();
  fireEvent.click(screen.getByRole("button", { name: "Stop sharing privately" }));
  await waitFor(() => expect(f.remove).toHaveBeenCalledWith(`/api/apps/${APP}/site`, { baseRevision: 3 }, expect.anything()));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop sharing privately" })).toBeNull());
  expect(f.patch).not.toHaveBeenCalled();
});

it("renews an expired entry and removes it using the new invitation and site revisions", async () => {
  const f = fixture(site, true, [invitation({ state: "expired" })]);
  render(<Host api={f.api} />); await ready();
  expect(screen.getByText("Expired")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Renew access for sara@example.com" }));
  await waitFor(() => expect(screen.getByTestId("revision").textContent).toBe("4"));
  expect(screen.getByText("Not opened yet")).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("button", { name: "Remove access for sara@example.com" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Remove access for sara@example.com" }));
  await waitFor(() => expect(screen.getByText("Removed")).toBeTruthy());
  expect(f.remove.mock.calls[0][1]).toEqual({ baseRevision: 4, invitationRevision: 1 });
});

it("says no email is sent, shows the link before anyone is added, and never claims delivery", async () => {
  const f = fixture(site, true, []);
  render(<Host api={f.api} />); await ready();
  expect(screen.getByText("We don’t send email. Copy the link and send it yourself. Only these people can open it after signing in.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  expect(screen.getByLabelText("Email address").getAttribute("placeholder")).toBe("Add people by email");
  await invite();
  expect(await screen.findByText("Added. Copy the link and send it to them.")).toBeTruthy();
  expect(screen.getByText("Not opened yet")).toBeTruthy();
  expect(screen.queryByText(/Email (queued|sent|processing|failed|stopped|status)/)).toBeNull();
  expect(screen.queryByText(/Invitation queued/)).toBeNull();
});

it("keeps the Private tab hidden when the server has not confirmed allowlist mode", async () => {
  const f = fixture(null);
  f.state.readiness = { privateEmailInvitations: true };
  render(<Host api={f.api} />); await ready();
  expect(screen.queryByRole("tab", { name: /Private/ })).toBeNull();
  expect(screen.queryByLabelText("Email address")).toBeNull();
});

it("keeps older invitation pages visible until explicitly returning to the newest page", async () => {
  const f = fixture(site, true, [invitation()]);
  f.state.next = "older";
  f.get.mockImplementation(async (path) => {
    if (path.includes("cursor=older")) return { invitations: [invitation({ id: "55555555-5555-4555-8555-555555555555", emailAddress: "older@example.com" })], siteRevision: 3, nextCursor: null };
    if (path.includes("/invitations?")) return { invitations: f.state.people, siteRevision: 3, nextCursor: "older" };
    return path.endsWith("/email-invitation-capabilities") ? { privateEmailInvitations: true, emailDelivery: "none" } : site;
  });
  render(<Host api={f.api} />); await ready();
  fireEvent.click(screen.getByRole("button", { name: "Load more invitations" }));
  expect(await screen.findByText("older@example.com")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show newest invitations" }));
  await waitFor(() => expect(screen.queryByText("older@example.com")).toBeNull());
  expect(screen.getByText("sara@example.com")).toBeTruthy();
});

it("ignores a late invitation result after switching the runtime/account client", async () => {
  const a = fixture(), b = fixture({ ...site, revision: 17 }, false);
  const pending = deferred<unknown>();
  a.post.mockImplementation(() => pending.promise);
  const view = render(<Host api={a.api} />); await ready(); await invite();
  await waitFor(() => expect(a.post).toHaveBeenCalledOnce());
  view.rerender(<Host api={b.api} />); await ready();
  await act(async () => pending.resolve({ results: [{ inputIndex: 0, outcome: "queued", invitation: invitation() }], siteRevision: 4 }));
  expect(screen.getByTestId("revision").textContent).toBe("17");
  expect(screen.queryByText("sara@example.com")).toBeNull();
  expect(screen.getByLabelText("Email address")).toHaveProperty("disabled", true);
});

it("keeps successful mode changes visible when queuing an invitation fails, without leaking service errors", async () => {
  const f = fixture({ ...site, accessMode: "private_link" });
  const normal = f.post.getMockImplementation()!;
  f.post.mockImplementation(async (path, value) => {
    if (path.endsWith("/invitations")) throw new SiteClientError(503);
    return normal(path, value);
  });
  render(<Host api={f.api} />); await ready(); await invite();
  fireEvent.click(screen.getByRole("button", { name: "Make invite-only" }));
  await waitFor(() => expect(screen.getByTestId("revision").textContent).toBe("4"));
  await waitFor(() => expect(within(screen.getByRole("tab", { name: /Private/ })).getByRole("img", { name: "on" })).toBeTruthy());
  expect(screen.getByRole("alert").textContent).toContain("Sharing is unavailable");
});


it("reloads the full site when the invitation read belongs to a newer publication revision", async () => {
 const f=fixture(site,true,[invitation()]);
 const normal=f.get.getMockImplementation()!;
 let changed=false;
 f.get.mockImplementation(async(path)=>{
  if(path.includes('/invitations?')&&!changed){changed=true;f.state.site={...site,title:'Newer title',slug:'newer-path',revision:4};}
  return normal(path);
 });
 render(<Host api={f.api}/>);await ready();
 expect(screen.getByTestId('revision').textContent).toBe('4');
 expect(screen.getByTestId('site-title').textContent).toBe('Newer title');
 expect(f.get.mock.calls.filter(([path])=>path.endsWith('/site')).length).toBeGreaterThan(1);
});

it("never promotes stale site fields to a newer post-mutation list revision", async () => {
 const f=fixture(site),fresh=deferred<unknown>();
 const normal=f.get.getMockImplementation()!;
 let held=false;
 f.get.mockImplementation(async(path)=>{
  if(path.endsWith('/site')&&f.state.site?.revision===5){held=true;return fresh.promise;}
  if(path.includes('/invitations?')&&f.state.site?.revision===4){
   f.state.site={...site,title:'Concurrent title',slug:'concurrent-path',revision:5};
  }
  return normal(path);
 });
 render(<Host api={f.api}/>);await ready();await invite();
 await waitFor(()=>expect(held).toBe(true));
 expect(screen.getByTestId('revision').textContent).toBe('4');
 await act(async()=>fresh.resolve(f.state.site));
 await waitFor(()=>expect(screen.getByTestId('site-title').textContent).toBe('Concurrent title'));
 expect(screen.getByTestId('revision').textContent).toBe('5');
});

it("prevents paging from cancelling a pending newest-page reset", async () => {
 const f=fixture(site,true,[invitation()]),fresh=deferred<unknown>();
 const older=invitation({id:'55555555-5555-4555-8555-555555555555',emailAddress:'older@example.com'});
 let reset=false,held=false;
 f.get.mockImplementation(async(path)=>{
  if(path.endsWith('/email-invitation-capabilities'))return {privateEmailInvitations:true,emailDelivery:'none'};
  if(path.endsWith('/site')){if(reset){held=true;return fresh.promise;}return site;}
  if(path.includes('cursor=older'))return {invitations:[older],siteRevision:3,nextCursor:'last'};
  return {invitations:[invitation()],siteRevision:3,nextCursor:'older'};
 });
 render(<Host api={f.api}/>);await ready();
 fireEvent.click(screen.getByRole('button',{name:'Load more invitations'}));
 expect(await screen.findByText('older@example.com')).toBeTruthy();
 reset=true;
 fireEvent.click(screen.getByRole('button',{name:'Show newest invitations'}));
 await waitFor(()=>expect(held).toBe(true));
 const paging=screen.getByRole('button',{name:'Load more invitations'});
 expect(paging).toHaveProperty('disabled',true);
 fireEvent.click(paging);
 expect(f.get.mock.calls.some(([path])=>path.includes('cursor=last'))).toBe(false);
 await act(async()=>fresh.resolve(site));
 await waitFor(()=>expect(screen.queryByText('older@example.com')).toBeNull());
 expect(screen.getByText('sara@example.com')).toBeTruthy();
});
