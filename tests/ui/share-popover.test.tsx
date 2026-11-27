// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SiteRecord } from "@matrix-os/contracts";
import { SharePanel, ShareTriggerLabel, createInMemoryEmailInvitations, useShareController, type EmailInvitationAdapter, type ShareController, type ShareSiteClient } from "../../packages/ui/src/share/index";

// Outcome: an owner shares an app by email invite (preview) or publicly on
// Matrix.page from one popover, and is warned before switching the single
// access mode. Faults detected: tabs changing access, switching without
// confirmation, wrong revision on the transition, the retired one-time-link
// UI reappearing, a legacy one-time-link site with no way to turn it off, a
// taken/reserved path being publishable.

const SITE_ID = "11111111-1111-4111-8111-111111111111";
const base: SiteRecord = {
  id: SITE_ID, appSlug: "sales-crm", title: "Sales CRM", description: "", slug: null,
  url: `https://matrix.page/${SITE_ID}`, revision: 3, status: "published", accessMode: "public",
  activeVersion: "22222222-2222-4222-8222-222222222222", versions: [], config: { data: {}, forms: [] },
};

function client(overrides: Partial<ShareSiteClient> = {}): ShareSiteClient & Record<string, ReturnType<typeof vi.fn>> {
  let stored: SiteRecord | null = null;
  const save = (site: SiteRecord) => { stored = site; return site; };
  return {
    get: vi.fn(async () => stored),
    deploy: vi.fn(async (_app, metadata) => save({ ...base, revision: 1, accessMode: metadata.accessMode ?? "public", slug: metadata.slug })),
    update: vi.fn(async (_app, metadata) => save({ ...base, revision: (metadata.baseRevision ?? 0) + 1, accessMode: metadata.accessMode ?? "public", slug: metadata.slug })),
    unpublish: vi.fn(async (_app, revision) => save({ ...base, revision: revision + 1, status: "unpublished" as const })),
    getConfig: vi.fn(async () => ({ data: {}, forms: [] })),
    slugAvailability: vi.fn(async () => ({ status: "available" as const, suggestions: [] })),
    ...overrides,
  } as ShareSiteClient & Record<string, ReturnType<typeof vi.fn>>;
}

/** Mirrors the window-header host: it owns the controller and renders trigger + panel. */
function Host({ api, emailInvites, organization, allowNewSharing, onController }: {
  api: ShareSiteClient; emailInvites: EmailInvitationAdapter | null; organization: boolean;
  allowNewSharing?: boolean; onController?: (share: ShareController) => void;
}) {
  const share = useShareController({ appSlug: "sales-crm", appName: "Sales CRM", client: api, emailInvites, allowNewSharing });
  onController?.(share);
  return <>
    <span data-testid="trigger"><ShareTriggerLabel pageMode={share.pageMode} orgShared={false} /></span>
    <SharePanel share={share} appSlug="sales-crm" appName="Sales CRM" client={api} ownerInitial="N" onClose={vi.fn()}
      organization={organization ? { shared: false, content: <p>Org content</p> } : null} />
  </>;
}
function renderPanel(api: ShareSiteClient, options: { emailInvites?: EmailInvitationAdapter | null; organization?: boolean; allowNewSharing?: boolean; onController?: (share: ShareController) => void } = {}) {
  render(<Host api={api} emailInvites={options.emailInvites ?? null} organization={options.organization ?? false}
    allowNewSharing={options.allowNewSharing} onController={options.onController} />);
}
const inPanel = () => within(screen.getByRole("region", { name: "Share app" }));
const publishButton = () => screen.getByRole("button", { name: /^Publish$/ });
const selectTab = (name: RegExp) => fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
const loaded = () => waitFor(() => expect(screen.queryByRole("status", { name: "Loading" })).toBeNull());

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Share popover shell", () => {
  it("uses tablist semantics, hides Private and Organization by default, and never changes access when switching tabs", async () => {
    const api = client();
    renderPanel(api, { organization: true });
    await loaded();
    expect(screen.getByRole("tablist", { name: "Sharing options" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Organization", "Public"]);
    expect(screen.getByRole("tab", { name: /Public/ }).getAttribute("aria-selected")).toBe("true");
    // The helper sentence under the tabs is gone; icons and short labels carry the meaning.
    expect(screen.queryByText("Get a public link anyone can use.")).toBeNull();
    selectTab(/Organization/);
    expect(screen.getByRole("tab", { name: /Organization/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Org content")).toBeTruthy();
    expect(api.update).not.toHaveBeenCalled();
    expect(api.deploy).not.toHaveBeenCalled();
  });

  it("shows only Public without an org or email invites, and never offers one-time links", async () => {
    renderPanel(client());
    await loaded();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Public"]);
    expect(screen.queryByText(/one-time link/i)).toBeNull();
  });

  it("shows the Private tab when email invites are enabled", async () => {
    renderPanel(client(), { emailInvites: createInMemoryEmailInvitations(), organization: true });
    await loaded();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Private", "Organization", "Public"]);
    expect(screen.getByRole("tab", { name: /Public/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("opens on Public with a green dot when the app is live and the trigger reads Live", async () => {
    renderPanel(client({ get: vi.fn(async () => ({ ...base, slug: "sales-crm" })) }));
    await loaded();
    const publicTab = screen.getByRole("tab", { name: /Public/ });
    expect(publicTab.getAttribute("aria-selected")).toBe("true");
    expect(within(publicTab).getByRole("img", { name: "on" })).toBeTruthy();
    expect(screen.getByText("matrix.page/sales-crm")).toBeTruthy();
    expect(inPanel().getByText("Live · Anyone with the link can view")).toBeTruthy();
    expect(screen.getByTestId("trigger").textContent).toBe("Live");
  });

  it("shows a spinner while loading and a short retryable error when sharing settings fail to load", async () => {
    let fail!: (error: unknown) => void;
    const get = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; })).mockResolvedValue(null);
    renderPanel(client({ get }));
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    fail(Object.assign(new Error("boom"), { status: 503 }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn’t load.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("Private tab · email invitations (stubbed adapter)", () => {
  it("enables Add only for a valid email, submits on Enter, and lists people with status, owner badge and revoke", async () => {
    const emailInvites = createInMemoryEmailInvitations();
    renderPanel(client(), { emailInvites });
    await loaded();
    selectTab(/Private/);
    const input = screen.getByLabelText("Email address");
    const invite = screen.getByRole("button", { name: "Add" });
    fireEvent.change(input, { target: { value: "sara@" } });
    expect(invite).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "sara@finna.ai" } });
    expect(invite).toHaveProperty("disabled", false);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("sara@finna.ai")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "People with access" })).getByText("Not opened yet")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    // No Matrix.page record exists yet, so there is no permanent URL to copy.
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    // Stopping private sharing is only offered for legacy one-time-link sites.
    expect(screen.queryByRole("button", { name: "Stop sharing privately" })).toBeNull();
    expect(within(screen.getByRole("tab", { name: /Private/ })).getByRole("img", { name: "on" })).toBeTruthy();
    expect(emailInvites.active("sales-crm")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove access for sara@finna.ai" }));
    await waitFor(() => expect(screen.queryByText("sara@finna.ai")).toBeNull());
  });

  it("renews an expired entry from an icon button named for the person", async () => {
    const emailInvites = createInMemoryEmailInvitations();
    const resend = vi.spyOn(emailInvites, "resend");
    const list = emailInvites.list.bind(emailInvites);
    vi.spyOn(emailInvites, "list").mockImplementation(async (app, signal) => {
      const page = await list(app, signal);
      return { ...page, invitations: page.invitations.map((person) => ({ ...person, state: "expired" as const })) };
    });
    renderPanel(client(), { emailInvites });
    await loaded();
    selectTab(/Private/);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "sara@finna.ai" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("button", { name: "Renew access for sara@finna.ai" }));
    await waitFor(() => expect(resend).toHaveBeenCalledWith("sales-crm", expect.any(String), expect.anything(), expect.any(AbortSignal)));
  });
});

describe("Private tab · legacy one-time-link sites", () => {
  it("shows one short line and Stop sharing, never one-time link controls, even without email invites", async () => {
    const api = client({ get: vi.fn(async () => ({ ...base, accessMode: "private_link" as const })) });
    renderPanel(api);
    await loaded();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Private", "Public"]);
    const privateTab = screen.getByRole("tab", { name: /Private/ });
    expect(privateTab.getAttribute("aria-selected")).toBe("true");
    expect(within(privateTab).getByRole("img", { name: "on" })).toBeTruthy();
    expect(screen.getByText("Uses retired one-time links")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New one-time link/ })).toBeNull();
    expect(screen.queryByLabelText("Email address")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing privately" }));
    await waitFor(() => expect(api.unpublish).toHaveBeenCalledWith("sales-crm", 3, expect.any(AbortSignal)));
  });
});

describe("Mode switch confirm", () => {
  it("asks before replacing public access with invite-only, does nothing on Cancel, and uses the revision on confirm", async () => {
    const emailInvites = createInMemoryEmailInvitations();
    const api = client({ get: vi.fn(async () => base) });
    renderPanel(api, { emailInvites });
    await loaded();
    selectTab(/Private/);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "sara@finna.ai" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const dialog = await screen.findByRole("dialog", { name: "Switch to invite-only?" });
    expect(within(dialog).getByText("The public link stops working for visitors. A Matrix.page app has one access mode at a time.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.unpublish).not.toHaveBeenCalled();
    expect(emailInvites.active("sales-crm")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Make invite-only" }));
    await waitFor(() => expect(api.unpublish).toHaveBeenCalledWith("sales-crm", 3, expect.any(AbortSignal)));
    expect(await screen.findByText("sara@finna.ai")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("revokes email invitations only after confirming a switch to public", async () => {
    const emailInvites = createInMemoryEmailInvitations();
    const api = client();
    renderPanel(api, { emailInvites });
    await loaded();
    selectTab(/Private/);
    for (const email of ["sara@finna.ai", "leo@northwind.studio"]) {
      fireEvent.change(screen.getByLabelText("Email address"), { target: { value: email } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(await screen.findByText(email)).toBeTruthy();
    }
    selectTab(/Public/);
    fireEvent.click(screen.getByRole("button", { name: /^Publish$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Switch to public?" });
    expect(within(dialog).getByText("2 invited people lose access, and their invites can’t be restored. A Matrix.page app has one access mode at a time.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Publish$/ })).toBeNull();
    expect(emailInvites.active("sales-crm")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Make public" }));
    await inPanel().findByText("Live · Anyone with the link can view");
    expect(emailInvites.active("sales-crm")).toBe(false);
    expect((await emailInvites.list("sales-crm", new AbortController().signal)).invitations).toEqual([]);
    expect(api.deploy).toHaveBeenCalledWith("sales-crm", expect.objectContaining({ accessMode: "public", slug: null }), expect.any(AbortSignal));
  });

  it("stops a legacy one-time-link site before entering invite-only (preview: unpublishes until 2691 lands)", async () => {
    const emailInvites = createInMemoryEmailInvitations();
    const api = client({ get: vi.fn(async () => ({ ...base, accessMode: "private_link" as const })) });
    renderPanel(api, { emailInvites });
    await loaded();
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "sara@finna.ai" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const dialog = await screen.findByRole("dialog", { name: "Switch to invite-only?" });
    expect(within(dialog).getByText(/Existing one-time links stop working\./)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Make invite-only" }));
    expect(await screen.findByText("sara@finna.ai")).toBeTruthy();
    expect(api.unpublish).toHaveBeenCalledWith("sales-crm", 3, expect.any(AbortSignal));
    expect(screen.getByLabelText("Email address")).toHaveProperty("value", "");
  });
});

describe("Public tab", () => {
  async function openPublic(api: ShareSiteClient) {
    renderPanel(api);
    await loaded();
    selectTab(/Public/);
    return screen.getByLabelText("Path");
  }

  it("validates paths locally and with the debounced platform check, using short messages", async () => {
    const slugAvailability = vi.fn(async (_app: string, slug: string) => slug === "crm"
      ? { status: "taken" as const, suggestions: ["crm-app", "crm-2"] }
      : { status: "available" as const, suggestions: [] });
    const api = client({ slugAvailability });
    const input = await openPublic(api);
    expect(input.getAttribute("placeholder")).toBe("permanent-id");
    expect(screen.queryByText("Optional")).toBeNull();
    expect(screen.queryByText(/permanent link/)).toBeNull();
    fireEvent.change(input, { target: { value: "a" } });
    expect(screen.getByText("2–63 lowercase letters, numbers, hyphens.")).toBeTruthy();
    expect(publishButton()).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "admin" } });
    expect(screen.getByText("Reserved")).toBeTruthy();
    expect(publishButton()).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "CRM" } });
    expect(input).toHaveProperty("value", "crm");
    expect(await screen.findByText("Taken.")).toBeTruthy();
    expect(screen.queryByText("Try")).toBeNull();
    expect(publishButton()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "crm-app" }));
    expect(input).toHaveProperty("value", "crm-app");
    expect(await screen.findByText("Available")).toBeTruthy();
    expect(publishButton()).toHaveProperty("disabled", false);
    expect(slugAvailability).not.toHaveBeenCalledWith("sales-crm", "a", expect.anything());
    expect(slugAvailability).not.toHaveBeenCalledWith("sales-crm", "admin", expect.anything());
  });

  it("says Couldn’t check when the platform check fails, and still allows publishing", async () => {
    const input = await openPublic(client({ slugAvailability: vi.fn().mockRejectedValue(Object.assign(new Error("down"), { status: 503 })) }));
    fireEvent.change(input, { target: { value: "launch" } });
    expect(await screen.findByText("Couldn’t check")).toBeTruthy();
    expect(publishButton()).toHaveProperty("disabled", false);
  });

  it("publishes with a path and title, then unpublishes from the live state", async () => {
    const api = client();
    const input = await openPublic(api);
    fireEvent.change(input, { target: { value: "sales-crm" } });
    await screen.findByText("Available");
    const metaToggle = screen.getByRole("button", { name: /Title & description/ });
    expect(metaToggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(metaToggle).getByText("Sales CRM")).toBeTruthy();
    fireEvent.click(metaToggle);
    const description = screen.getByLabelText("Description");
    expect(description.getAttribute("placeholder")).toBe("What it does");
    expect(screen.queryByText("Shown in link previews and search results.")).toBeNull();
    fireEvent.change(description, { target: { value: "x".repeat(901) } });
    expect(screen.getByText("901/1000")).toBeTruthy();
    fireEvent.change(description, { target: { value: "Track deals" } });
    expect(screen.queryByText("11/1000")).toBeNull();
    fireEvent.click(publishButton());
    expect(await screen.findByText("matrix.page/sales-crm")).toBeTruthy();
    expect(api.deploy).toHaveBeenCalledWith("sales-crm", expect.objectContaining({ accessMode: "public", slug: "sales-crm", title: "Sales CRM", description: "Track deals" }), expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    await waitFor(() => expect(api.unpublish).toHaveBeenCalledWith("sales-crm", 1, expect.any(AbortSignal)));
    expect(await screen.findByRole("button", { name: /^Publish$/ })).toBeTruthy();
  });

  it("maps a lost alias race at publish time to Taken", async () => {
    const api = client({ deploy: vi.fn().mockRejectedValue(Object.assign(new Error("conflict"), { status: 409 })) });
    const input = await openPublic(api);
    fireEvent.change(input, { target: { value: "launch" } });
    await screen.findByText("Available");
    fireEvent.click(publishButton());
    expect(await screen.findByText("Taken.")).toBeTruthy();
    expect(publishButton()).toHaveProperty("disabled", true);
  });
});

describe("review fixes: owner controls and stale state", () => {
  it("publishes the latest app version and saves details on a live site without unpublishing", async () => {
    const api = client({ get: vi.fn(async () => ({ ...base, slug: "sales-crm" })) });
    renderPanel(api);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(api.deploy).toHaveBeenCalledWith("sales-crm", expect.objectContaining({ accessMode: "public", slug: "sales-crm", baseRevision: 3 }), expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("button", { name: "Edit details" }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Track deals" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("sales-crm", expect.objectContaining({ accessMode: "public", description: "Track deals" }), expect.any(AbortSignal)));
    expect(api.unpublish).not.toHaveBeenCalled();
  });

  it("blocks every access change while the publication is unknown", async () => {
    const api = client({ get: vi.fn(async () => { throw Object.assign(new Error("down"), { status: 503 }); }) });
    renderPanel(api, { emailInvites: createInMemoryEmailInvitations() });
    await screen.findByRole("button", { name: "Retry" });
    selectTab(/Private/);
    expect(screen.getByLabelText("Email address")).toHaveProperty("disabled", true);
    selectTab(/Public/);
    expect(publishButton()).toHaveProperty("disabled", true);
    expect(api.deploy).not.toHaveBeenCalled();
    expect(api.unpublish).not.toHaveBeenCalled();
  });

  it("keeps a running action alive when the popover reopens mid-publish", async () => {
    let finish!: (site: SiteRecord) => void;
    const deploy = vi.fn((_app: string, _metadata: unknown, _signal: AbortSignal) => new Promise<SiteRecord>((resolve) => { finish = resolve; }));
    const get = vi.fn(async () => ({ ...base, slug: "sales-crm" }));
    const api = client({ get, deploy });
    function RefreshingHost() {
      const share = useShareController({ appSlug: "sales-crm", appName: "Sales CRM", client: api, emailInvites: null });
      return <>
        <button type="button" onClick={share.refresh}>Reopen</button>
        <SharePanel share={share} appSlug="sales-crm" appName="Sales CRM" client={api} ownerInitial="N" onClose={vi.fn()} organization={null} />
      </>;
    }
    render(<RefreshingHost />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(deploy).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    finish({ ...base, slug: "sales-crm", revision: 4 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Update" })).toHaveProperty("disabled", false));
    expect(deploy.mock.calls[0]![2].aborted).toBe(false);
  });

  it("re-reads the publication after a revision conflict", async () => {
    const get = vi.fn(async () => ({ ...base, slug: "sales-crm" }));
    const api = client({ get, deploy: vi.fn().mockRejectedValue(Object.assign(new Error("conflict"), { status: 409 })) });
    renderPanel(api);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(await screen.findByText("This changed somewhere else. Refresh and try again.")).toBeTruthy();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});

// Outcome: Matrix default apps (Calculator, Notes, games) never start sharing, yet an
// owner who shared one earlier can still stop it. Faults detected: a stop-only app
// offering new invites, resends, publish or detail edits, and a stray request
// (stale button, script) creating a new publication for a default app.
describe("Stop-only sharing for default apps", () => {
  it("keeps Remove on an invite-only default app but offers no new invites or renewals", async () => {
    const emailInvites = createInMemoryEmailInvitations();
    const signal = new AbortController().signal;
    await emailInvites.activate("sales-crm", signal);
    await emailInvites.invite("sales-crm", { emailAddresses: ["sara@finna.ai"], baseRevision: 1 }, signal);
    const api = client();
    renderPanel(api, { emailInvites, allowNewSharing: false });
    await loaded();
    expect(await screen.findByText("sara@finna.ai")).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Private"]);
    expect(screen.queryByLabelText("Email address")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Renew access/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove access for sara@finna.ai" }));
    await waitFor(() => expect(screen.queryByText("sara@finna.ai")).toBeNull());
  });

  it("keeps Stop sharing privately on a published invite-only default app", async () => {
    const api = client({ get: vi.fn(async () => ({ ...base, accessMode: "private_email" as SiteRecord["accessMode"] })) });
    renderPanel(api, { allowNewSharing: false });
    await loaded();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Private"]);
    expect(screen.queryByLabelText("Email address")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing privately" }));
    await waitFor(() => expect(api.unpublish).toHaveBeenCalledWith("sales-crm", 3, expect.any(AbortSignal)));
  });

  it("refuses to publish, update or edit details when new sharing is not allowed", async () => {
    let controller: ShareController | null = null;
    const api = client({ get: vi.fn(async () => base) });
    renderPanel(api, { allowNewSharing: false, onController: (share) => { controller = share; } });
    await loaded();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    const metadata = { title: "Sales CRM", description: "", slug: "crm" };
    expect(await controller!.request({ to: "private_email", email: "sara@finna.ai" })).toBe(false);
    expect(await controller!.publishUpdate()).toBe(false);
    expect(await controller!.saveDetails(metadata)).toBe(false);
    expect(api.deploy).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
  });

  it("shows no Publish form on a default app that is not published", async () => {
    let controller: ShareController | null = null;
    const api = client();
    renderPanel(api, { allowNewSharing: false, onController: (share) => { controller = share; } });
    await loaded();
    expect(screen.queryByRole("button", { name: /^Publish$/ })).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(await controller!.request({ to: "public", metadata: { title: "Sales CRM", description: "", slug: null } })).toBe(false);
    expect(api.deploy).not.toHaveBeenCalled();
  });
});
