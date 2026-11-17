// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SiteRecord } from "@matrix-os/contracts";
import { SharePanel, ShareTriggerLabel, createInMemoryEmailInvitations, useShareController, type EmailInvitationAdapter, type ShareSiteClient } from "../../packages/ui/src/share/index";

// Outcome: an owner can share an app privately (email / one-time links) or
// publicly on Matrix.page from one popover, and is warned before switching the
// single access mode. Faults detected: tabs changing access, switching without
// confirmation, wrong revision on the transition, the secret URL being
// re-shown, a taken/reserved path being publishable.

const SITE_ID = "11111111-1111-4111-8111-111111111111";
const LINK_ID = "44444444-4444-4444-8444-444444444444";
const base: SiteRecord = {
  id: SITE_ID, appSlug: "sales-crm", title: "Sales CRM", description: "", slug: null,
  url: `https://matrix.page/${SITE_ID}`, revision: 3, status: "published", accessMode: "public",
  activeVersion: "22222222-2222-4222-8222-222222222222", versions: [], config: { data: {}, forms: [] },
};
const link = (status: "unclaimed" | "claimed" | "expired" = "unclaimed", id = LINK_ID) => ({ id, status, createdAt: "2026-11-05T12:00:00.000Z", claimExpiresAt: "2026-11-12T12:00:00.000Z", claimedAt: null, sessionExpiresAt: null });
const secretUrl = `https://matrix.page/${SITE_ID}#access=${LINK_ID}.${"a".repeat(43)}`;

function client(overrides: Partial<ShareSiteClient> = {}): ShareSiteClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    get: vi.fn(async () => null),
    deploy: vi.fn(async (_app, metadata) => ({ ...base, revision: 1, accessMode: metadata.accessMode ?? "public", slug: metadata.slug })),
    update: vi.fn(async (_app, metadata) => ({ ...base, revision: (metadata.baseRevision ?? 0) + 1, accessMode: metadata.accessMode ?? "public", slug: metadata.slug })),
    unpublish: vi.fn(async (_app, revision) => ({ ...base, revision: revision + 1, status: "unpublished" as const })),
    getConfig: vi.fn(async () => ({ data: {}, forms: [] })),
    accessLinks: vi.fn(async () => ({ links: [], nextCursor: null })),
    createAccessLink: vi.fn(async () => ({ link: link(), url: secretUrl })),
    revokeAccessLink: vi.fn(async () => undefined),
    slugAvailability: vi.fn(async () => ({ status: "available" as const, suggestions: [] })),
    ...overrides,
  } as ShareSiteClient & Record<string, ReturnType<typeof vi.fn>>;
}

/** Mirrors the window-header host: it owns the controller and renders trigger + panel. */
function Host({ api, emailInvites, organization }: { api: ShareSiteClient; emailInvites: EmailInvitationAdapter | null; organization: boolean }) {
  const share = useShareController({ appSlug: "sales-crm", appName: "Sales CRM", client: api, emailInvites });
  return <>
    <span data-testid="trigger"><ShareTriggerLabel pageMode={share.pageMode} orgShared={false} /></span>
    <SharePanel share={share} appSlug="sales-crm" appName="Sales CRM" client={api} ownerInitial="N" onClose={vi.fn()}
      organization={organization ? { shared: false, organizationName: "Finna", content: <p>Org content</p> } : null} />
  </>;
}
function renderPanel(api: ShareSiteClient, options: { emailInvites?: EmailInvitationAdapter | null; organization?: boolean } = {}) {
  render(<Host api={api} emailInvites={options.emailInvites ?? null} organization={options.organization ?? false} />);
}
const selectTab = (name: RegExp) => fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
const loaded = () => waitFor(() => expect(screen.queryByText("Loading sharing settings…")).toBeNull());

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Share popover shell", () => {
  it("uses tablist semantics, hides Organization without an org, and never changes access when switching tabs", async () => {
    const api = client();
    renderPanel(api);
    await loaded();
    expect(screen.getByRole("tablist", { name: "Sharing options" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Private", "Public"]);
    expect(screen.getByText("Invite people by email, or create one-time links.")).toBeTruthy();
    selectTab(/Public/);
    expect(screen.getByRole("tab", { name: /Public/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Get a public link anyone can use.")).toBeTruthy();
    expect(api.update).not.toHaveBeenCalled();
    expect(api.deploy).not.toHaveBeenCalled();
  });

  it("shows the Organization tab only when the host supplies one", async () => {
    renderPanel(client(), { organization: true });
    await loaded();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Private", "Organization", "Public"]);
    selectTab(/Organization/);
    expect(screen.getByText("Org content")).toBeTruthy();
  });

  it("opens on Public with a green dot when the app is live and the trigger reads Live", async () => {
    renderPanel(client({ get: vi.fn(async () => ({ ...base, slug: "sales-crm" })) }));
    await loaded();
    const publicTab = screen.getByRole("tab", { name: /Public/ });
    expect(publicTab.getAttribute("aria-selected")).toBe("true");
    expect(within(publicTab).getByRole("img", { name: "on" })).toBeTruthy();
    expect(screen.getByText("matrix.page/sales-crm")).toBeTruthy();
    expect(screen.getByText("Live · visitors can use, not edit")).toBeTruthy();
    expect(screen.getByTestId("trigger").textContent).toBe("Live");
  });

  it("shows a retryable error when sharing settings fail to load", async () => {
    const get = vi.fn().mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 503 })).mockResolvedValue(null);
    renderPanel(client({ get }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("Private tab · email invitations (stubbed adapter)", () => {
  it("keeps email invites unavailable without the preview adapter", async () => {
    renderPanel(client());
    await loaded();
    expect(screen.getByLabelText("Email address")).toHaveProperty("disabled", true);
    expect(screen.getByText("Email invitations aren’t available yet. Use one-time links for now.")).toBeTruthy();
  });

  it("enables Invite only for a valid email, submits on Enter, and lists people with status and remove", async () => {
    const emailInvites = createInMemoryEmailInvitations();
    renderPanel(client(), { emailInvites });
    await loaded();
    const input = screen.getByLabelText("Email address");
    const invite = screen.getByRole("button", { name: "Invite" });
    fireEvent.change(input, { target: { value: "sara@" } });
    expect(invite).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "sara@finna.ai" } });
    expect(invite).toHaveProperty("disabled", false);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("sara@finna.ai")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Only invited people can open it. They sign in with their email.")).toBeTruthy();
    // No Matrix.page record exists yet, so there is no permanent URL to copy.
    expect(screen.queryByText("Invited people sign in to open it")).toBeNull();
    expect(within(screen.getByRole("tab", { name: /Private/ })).getByRole("img", { name: "on" })).toBeTruthy();
    expect(emailInvites.active("sales-crm")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove sara@finna.ai" }));
    await waitFor(() => expect(screen.queryByText("sara@finna.ai")).toBeNull());
  });
});

describe("Private tab · one-time links", () => {
  it("is collapsed by default, privately publishes an unpublished app, and shows Copy only right after creation", async () => {
    const api = client();
    renderPanel(api);
    await loaded();
    const toggle = screen.getByRole("button", { name: /One-time links/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "New one-time link" }));
    expect(await screen.findByText("Unclaimed")).toBeTruthy();
    expect(api.getConfig).toHaveBeenCalledTimes(1);
    expect(api.deploy).toHaveBeenCalledWith("sales-crm", expect.objectContaining({ accessMode: "private_link", title: "Sales CRM", reviewedConfig: { data: {}, forms: [] } }), expect.any(AbortSignal));
    expect(api.createAccessLink).toHaveBeenCalledWith("sales-crm", { baseRevision: 1 }, expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    // The secret itself is never rendered, only a masked label.
    expect(screen.queryByText(secretUrl)).toBeNull();
    expect(screen.getByLabelText("1 links")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Revoke one-time link/ }));
    await waitFor(() => expect(api.revokeAccessLink).toHaveBeenCalledWith("sales-crm", LINK_ID, expect.any(AbortSignal)));
    await waitFor(() => expect(screen.queryByText("Unclaimed")).toBeNull());
  });

  it("lists existing links with status, no Copy after reload, and no revoke for expired links", async () => {
    const privateSite = { ...base, accessMode: "private_link" as const };
    const links = [link("claimed", "55555555-5555-4555-8555-555555555555"), link("expired", "66666666-6666-4666-8666-666666666666")];
    renderPanel(client({ get: vi.fn(async () => privateSite), accessLinks: vi.fn(async () => ({ links, nextCursor: null })) }));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /One-time links/ }));
    expect(screen.getByText("Claimed")).toBeTruthy();
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /Revoke one-time link/ })).toHaveLength(1);
    expect(screen.getByText("Anyone with a one-time link can open it once, in their browser.")).toBeTruthy();
  });

  it("shows a safe error when link creation fails", async () => {
    renderPanel(client({ createAccessLink: vi.fn().mockRejectedValue(Object.assign(new Error("db said no"), { status: 503 })) }));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /One-time links/ }));
    fireEvent.click(screen.getByRole("button", { name: "New one-time link" }));
    expect(await screen.findByText("Sharing is unavailable right now. Try again.")).toBeTruthy();
    expect(screen.queryByText(/db said no/)).toBeNull();
  });
});

describe("Mode switch confirm", () => {
  it("asks before replacing public access with one-time links, does nothing on Cancel, and uses the revision on confirm", async () => {
    const api = client({ get: vi.fn(async () => base) });
    renderPanel(api);
    await loaded();
    selectTab(/Private/);
    fireEvent.click(screen.getByRole("button", { name: /One-time links/ }));
    fireEvent.click(screen.getByRole("button", { name: "New one-time link" }));
    const dialog = await screen.findByRole("dialog", { name: "Switch to one-time links?" });
    expect(within(dialog).getByText("The public link stops working for visitors. A Matrix.page app has one access mode at a time.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.update).not.toHaveBeenCalled();
    expect(api.createAccessLink).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "New one-time link" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Use one-time links" }));
    await waitFor(() => expect(api.createAccessLink).toHaveBeenCalledWith("sales-crm", { baseRevision: 4 }, expect.any(AbortSignal)));
    expect(api.update).toHaveBeenCalledWith("sales-crm", expect.objectContaining({ accessMode: "private_link", baseRevision: 3 }), expect.any(AbortSignal));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("revokes email invitations only after confirming a switch to public", async () => {
    const emailInvites = createInMemoryEmailInvitations();
    const api = client();
    renderPanel(api, { emailInvites });
    await loaded();
    for (const email of ["sara@finna.ai", "leo@northwind.studio"]) {
      fireEvent.change(screen.getByLabelText("Email address"), { target: { value: email } });
      fireEvent.click(screen.getByRole("button", { name: "Invite" }));
      expect(await screen.findByText(email)).toBeTruthy();
    }
    selectTab(/Public/);
    expect(screen.getByText("Publishing makes it public and replaces private access.")).toBeTruthy();
    await screen.findByText("Leave empty to use the permanent link. Your app always keeps its permanent link, even with a friendly path.");
    fireEvent.click(screen.getByRole("button", { name: /Publish to web/ }));
    const dialog = await screen.findByRole("dialog", { name: "Switch to public?" });
    expect(within(dialog).getByText("2 invited people lose access, and their invites can’t be restored. A Matrix.page app has one access mode at a time.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Publish to web/ })).toBeNull();
    expect(emailInvites.active("sales-crm")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Make public" }));
    await screen.findByText("Live · visitors can use, not edit");
    expect(emailInvites.active("sales-crm")).toBe(false);
    expect((await emailInvites.list("sales-crm", new AbortController().signal)).invitations).toEqual([]);
    expect(api.deploy).toHaveBeenCalledWith("sales-crm", expect.objectContaining({ accessMode: "public", slug: null }), expect.any(AbortSignal));
  });

  it("stops one-time links before entering invite-only (preview: unpublishes until 2691 lands)", async () => {
    const emailInvites = createInMemoryEmailInvitations();
    const api = client({ get: vi.fn(async () => ({ ...base, accessMode: "private_link" as const })) });
    renderPanel(api, { emailInvites });
    await loaded();
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "sara@finna.ai" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
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
    return screen.getByLabelText("Friendly path");
  }

  it("validates friendly paths locally and with the debounced platform check", async () => {
    const slugAvailability = vi.fn(async (_app: string, slug: string) => slug === "crm"
      ? { status: "taken" as const, suggestions: ["crm-app", "crm-2"] }
      : { status: "available" as const, suggestions: [] });
    const api = client({ slugAvailability });
    const input = await openPublic(api);
    const publish = () => screen.getByRole("button", { name: /Publish to web/ });
    expect(input.getAttribute("placeholder")).toBe("permanent-id");
    fireEvent.change(input, { target: { value: "a" } });
    expect(screen.getByText("Use 2–63 lowercase letters, numbers or hyphens, starting with a letter.")).toBeTruthy();
    expect(publish()).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "admin" } });
    expect(screen.getByText("This path is reserved.")).toBeTruthy();
    expect(publish()).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "CRM" } });
    expect(input).toHaveProperty("value", "crm");
    expect(await screen.findByText("Taken.")).toBeTruthy();
    expect(publish()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "crm-app" }));
    expect(input).toHaveProperty("value", "crm-app");
    expect(await screen.findByText("Available")).toBeTruthy();
    expect(publish()).toHaveProperty("disabled", false);
    expect(slugAvailability).not.toHaveBeenCalledWith("sales-crm", "a", expect.anything());
    expect(slugAvailability).not.toHaveBeenCalledWith("sales-crm", "admin", expect.anything());
  });

  it("publishes with a friendly path and title, then unpublishes from the live state", async () => {
    const api = client();
    const input = await openPublic(api);
    fireEvent.change(input, { target: { value: "sales-crm" } });
    await screen.findByText("Available");
    const metaToggle = screen.getByRole("button", { name: /Title & description/ });
    expect(metaToggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(metaToggle).getByText("Sales CRM")).toBeTruthy();
    fireEvent.click(metaToggle);
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Track deals" } });
    expect(screen.getByText("11/1000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Publish to web/ }));
    expect(await screen.findByText("matrix.page/sales-crm")).toBeTruthy();
    expect(api.deploy).toHaveBeenCalledWith("sales-crm", expect.objectContaining({ accessMode: "public", slug: "sales-crm", title: "Sales CRM", description: "Track deals" }), expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    await waitFor(() => expect(api.unpublish).toHaveBeenCalledWith("sales-crm", 1, expect.any(AbortSignal)));
    expect(await screen.findByText("Get a public link anyone can use.")).toBeTruthy();
  });

  it("maps a lost alias race at publish time to Taken", async () => {
    const api = client({ deploy: vi.fn().mockRejectedValue(Object.assign(new Error("conflict"), { status: 409 })) });
    const input = await openPublic(api);
    fireEvent.change(input, { target: { value: "launch" } });
    await screen.findByText("Available");
    fireEvent.click(screen.getByRole("button", { name: /Publish to web/ }));
    expect(await screen.findByText("Taken.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Publish to web/ })).toHaveProperty("disabled", true);
  });
});

describe("review fixes: owner controls and stale state", () => {
  it("publishes the latest app version and saves details on a live site without unpublishing", async () => {
    const api = client({ get: vi.fn(async () => ({ ...base, slug: "sales-crm" })) });
    renderPanel(api);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Publish latest version" }));
    await waitFor(() => expect(api.deploy).toHaveBeenCalledWith("sales-crm", expect.objectContaining({ accessMode: "public", slug: "sales-crm", baseRevision: 3 }), expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("button", { name: "Edit details" }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Track deals" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("sales-crm", expect.objectContaining({ accessMode: "public", description: "Track deals" }), expect.any(AbortSignal)));
    expect(api.unpublish).not.toHaveBeenCalled();
  });

  it("stops private sharing for a one-time-link site", async () => {
    const api = client({ get: vi.fn(async () => ({ ...base, accessMode: "private_link" as const })) });
    renderPanel(api);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing privately" }));
    await waitFor(() => expect(api.unpublish).toHaveBeenCalledWith("sales-crm", 3, expect.any(AbortSignal)));
  });

  it("blocks every access change while the publication is unknown", async () => {
    const api = client({ get: vi.fn(async () => { throw Object.assign(new Error("down"), { status: 503 }); }) });
    renderPanel(api, { emailInvites: createInMemoryEmailInvitations() });
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByLabelText("Email address")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: /One-time links/ }));
    expect(screen.getByRole("button", { name: "New one-time link" })).toHaveProperty("disabled", true);
    selectTab(/Public/);
    expect(screen.getByRole("button", { name: /Publish to web/ })).toHaveProperty("disabled", true);
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
    fireEvent.click(screen.getByRole("button", { name: "Publish latest version" }));
    await waitFor(() => expect(deploy).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    finish({ ...base, slug: "sales-crm", revision: 4 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish latest version" })).toHaveProperty("disabled", false));
    expect(deploy.mock.calls[0]![2].aborted).toBe(false);
  });

  it("re-reads the publication after a revision conflict", async () => {
    const get = vi.fn(async () => ({ ...base, accessMode: "private_link" as const }));
    const api = client({ get, createAccessLink: vi.fn().mockRejectedValue(Object.assign(new Error("conflict"), { status: 409 })) });
    renderPanel(api);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /One-time links/ }));
    fireEvent.click(screen.getByRole("button", { name: "New one-time link" }));
    expect(await screen.findByText("This changed somewhere else. Refresh and try again.")).toBeTruthy();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});
