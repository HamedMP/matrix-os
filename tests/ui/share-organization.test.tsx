// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharePanel, ShareTriggerLabel, useShareController, useShareOrganization, type ShareOrganization, type ShareSiteClient } from "../../packages/ui/src/share/index";
import { HANDOFF_POLL_MS } from "../../packages/ui/src/share/use-collaborative-handoff";

// Outcome: an owner shares a live app with one org from the Organization tab.
// ENG-579: any app shares after a completed readiness check (view-only until it
// is collaborative); "Make it collaborative" is an optional suggestion with a
// green tick once the build is collaborative.
// Faults detected: sharing without a completed readiness result, blocking a
// share on collaboration, a completion event sharing a non-collaborative app,
// the wrong org/request in the Chats handoff, and a stale completion
// re-sharing after Stop sharing.

const ORG = "org_finna_team";
const ORG2 = "org_northwind";
const finna: ShareOrganization = { organizationId: ORG, name: "Finna", memberCount: 24 };
const northwind: ShareOrganization = { organizationId: ORG2, name: "Northwind Studio", memberCount: 8 };
const build = {
  appId: "sales-crm", catalogId: "30000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64), manifestVersion: "1.0.0", buildId: "b".repeat(64),
  manifestDigest: "c".repeat(64), schemaDigest: "d".repeat(64), assetDigest: "e".repeat(64),
  bridgeContractVersion: "matrix-app-bridge-v1", runtimeAbi: "matrix-runtime-v1",
};
const codes = ["declaration", "exact_build", "owner_postgres", "recipient_launch", "participant_identity", "idempotent_retry", "conflict_write", "change_signal", "provider_safety", "cleanup"];
const readiness = (status: "ready" | "blocked" | "failed", revision = "2") => ({
  readinessId: "40000000-0000-4000-8000-000000000001", build, status, revision,
  checks: codes.map((code) => status === "ready" || code !== "owner_postgres" ? { code, status: "passed" } : { code, status, action: "Use shared owner-backed reads in the built app and recheck." }),
  ...(status === "ready" ? { verifiedAt: "2026-11-05T10:00:00.000Z" } : {}),
});
const share = (state: "active" | "stopped" = "active") => ({
  scopeId: "10000000-0000-4000-8000-000000000001", organizationId: ORG,
  owner: { actorId: "user_owner", displayName: "Nima" }, build, readinessId: "40000000-0000-4000-8000-000000000001",
  state, shareRevision: "1", bindingRevision: "1", dataRevision: "0",
  createdAt: "2026-11-05T10:00:00.000Z", updatedAt: "2026-11-05T10:00:00.000Z",
});

function collaboration(checkResults: Array<"ready" | "blocked" | "failed">, options: { initialShare?: unknown; initialReadiness?: "ready" | "blocked"; preflightGate?: Promise<void>; shareGate?: Promise<void>; shareReadFailures?: number; checkGate?: Promise<void>; readinessReadFails?: boolean } = {}) {
  let current: unknown = options.initialReadiness ? readiness(options.initialReadiness) : null;
  let currentShare: unknown = options.initialShare ?? null;
  let shareReadFailures = options.shareReadFailures ?? 0;
  const results = [...checkResults];
  let checkCount = 0;
  return {
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/registration")) return { registrationIncarnation: build.registrationIncarnation };
      if (path.endsWith("/share")) {
        if (shareReadFailures > 0) { shareReadFailures -= 1; throw new Error("share read failed"); }
        return currentShare;
      }
      if (options.readinessReadFails) throw new Error("readiness read failed");
      return current;
    }),
    post: vi.fn(async (path: string, _body: unknown) => {
      if (path.endsWith("/readiness/check")) { await options.checkGate; checkCount += 1; current = readiness(results.shift() ?? "blocked", String(checkCount + 1)); return current; }
      if (path.endsWith("/share/preflight")) await options.preflightGate;
      if (path.endsWith("/share/preflight")) return { eligible: true, catalogId: build.catalogId, resourceRevision: "0", readinessId: "40000000-0000-4000-8000-000000000001", buildId: build.buildId, confirmationToken: "token_payload.signature_value" };
      if (path.endsWith("/share")) { currentShare = share(); await options.shareGate; return currentShare; }
      throw new Error(`unexpected ${path}`);
    }),
    delete: vi.fn(async () => { currentShare = { ...share("stopped"), updatedAt: new Date().toISOString() }; return currentShare; }),
  };
}

function files(initial: unknown = null, options: { firstPutGate?: Promise<void> } = {}) {
  let stored: unknown = initial;
  let gate = options.firstPutGate;
  return {
    get: vi.fn(async () => { if (stored === null) throw Object.assign(new Error("missing"), { category: "notFound" }); return stored; }),
    // Mirrors the gateway blob route: replacing an existing file needs force=true.
    put: vi.fn(async (path: string, body: unknown) => {
      const waiting = gate; gate = undefined;
      if (waiting) await waiting;
      if (stored !== null && !path.includes("force=true")) throw Object.assign(new Error("file_exists"), { status: 409 });
      stored = body; return { ok: true };
    }),
    /** Simulates the builder skill rewriting the record. */
    skillWrites: (patch: Record<string, unknown>) => { stored = { ...(stored as object), ...patch, updatedAt: "2026-11-15T12:00:00.000Z" }; },
    current: () => stored as Record<string, unknown> | null,
  };
}

const site: ShareSiteClient = {
  get: vi.fn(async () => null), deploy: vi.fn(), update: vi.fn(), unpublish: vi.fn(), getConfig: vi.fn(),
  slugAvailability: vi.fn(async () => ({ status: "available" as const, suggestions: [] })),
};

function Host({ organizations, api, fileApi, startChat = vi.fn(async () => true), allowNewSharing }: {
  organizations: ShareOrganization[]; api: ReturnType<typeof collaboration>; fileApi: ReturnType<typeof files>; startChat?: (prompt: string) => Promise<boolean>;
  allowNewSharing?: boolean;
}) {
  const controller = useShareController({ appSlug: "sales-crm", appName: "Sales CRM", client: site, emailInvites: null, allowNewSharing });
  const organization = useShareOrganization({
    appSlug: "sales-crm", appName: "Sales CRM", organizations, preferredOrganizationId: ORG, allowNewSharing,
    collaborationApi: api, fileApi, startChat, openChat: vi.fn(),
    orgLink: (value, hints) => `https://app.matrix-os.com/open/shared-app/${value.scopeId}?app=${hints.app}`,
  });
  return <>
    <span data-testid="trigger"><ShareTriggerLabel pageMode={controller.pageMode} orgShared={organization.shared} /></span>
    <SharePanel share={controller} appSlug="sales-crm" appName="Sales CRM" client={site} ownerInitial="N" onClose={vi.fn()} organization={organization.slot} />
  </>;
}
const openOrganizationTab = async () => fireEvent.mouseDown(await screen.findByRole("tab", { name: /Organization/ }), { button: 0 });

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Organization tab", () => {
  it("is hidden when the owner belongs to no organization", async () => {
    render(<Host organizations={[]} api={collaboration([])} fileApi={files()} />);
    await screen.findByRole("tab", { name: /Public/ });
    expect(screen.queryByRole("tab", { name: /Organization/ })).toBeNull();
  });

  it("shows a static org card with one membership and a picker with several, with Share beside it", async () => {
    const { unmount } = render(<Host organizations={[finna]} api={collaboration([])} fileApi={files()} />);
    await openOrganizationTab();
    const card = screen.getByRole("group", { name: "Share in Finna" });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(within(card).getByText("24 members")).toBeTruthy();
    // The org name appears once; the Share button carries it in its accessible name.
    expect(screen.getAllByText("Finna")).toHaveLength(1);
    const shareButton = within(card).getByRole("button", { name: "Share with Finna" });
    expect(shareButton.textContent).toBe("Share");
    unmount();
    render(<Host organizations={[finna, northwind]} api={collaboration([])} fileApi={files()} />);
    await openOrganizationTab();
    const trigger = screen.getByRole("combobox", { name: "Share in Finna, change organization" });
    // The Share button is a sibling of the Select trigger, never nested inside it.
    expect(within(trigger).queryByRole("button")).toBeNull();
    expect(trigger.contains(screen.getByRole("button", { name: "Share with Finna" }))).toBe(false);
  });

  it("shares immediately when readiness passes, then stops sharing in one click", async () => {
    const api = collaboration(["ready"]);
    render(<Host organizations={[finna]} api={api} fileApi={files()} />);
    await openOrganizationTab();
    fireEvent.click(await screen.findByRole("button", { name: "Share with Finna" }));
    const copy = await screen.findByRole("button", { name: "Copy Finna link" });
    const card = screen.getByRole("group", { name: "Share in Finna" });
    expect(within(card).getByText("Shared")).toBeTruthy();
    expect(card.contains(copy)).toBe(true);
    expect(screen.queryByText("Finna link")).toBeNull();
    expect(screen.getByTestId("trigger").textContent).toBe("Shared");
    expect(within(screen.getByRole("tab", { name: /Organization/ })).getByRole("img", { name: "on" })).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/share/preflight", expect.objectContaining({ organizationId: ORG }));
    const stop = screen.getByRole("button", { name: "Stop sharing with Finna" });
    expect(stop.getAttribute("title")).toBe("Stop sharing with Finna");
    fireEvent.click(stop);
    await waitFor(() => expect(api.delete).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Share with Finna" })).toBeTruthy();
  });

  it("keeps Stop sharing for a default app already shared with an org, and never offers a new share", async () => {
    // Fault: hiding Share on default apps strands an org share of Notes with no way to stop it.
    const api = collaboration([], { initialShare: share() });
    render(<Host organizations={[finna]} api={api} fileApi={files()} allowNewSharing={false} />);
    await openOrganizationTab();
    const stop = await screen.findByRole("button", { name: "Stop sharing with Finna" });
    expect(screen.getByTestId("trigger").textContent).toBe("Shared");
    fireEvent.click(stop);
    await waitFor(() => expect(api.delete).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("tab", { name: /Organization/ })).toBeNull());
    expect(screen.queryByRole("button", { name: "Share with Finna" })).toBeNull();
    expect(api.post).not.toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/share", expect.anything());
  });

  it("hides the Organization tab for a default app that is not shared", async () => {
    // Fault: a default app offering a new org share like an app the owner built.
    const api = collaboration([]);
    render(<Host organizations={[finna]} api={api} fileApi={files()} allowNewSharing={false} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/\/share$/)));
    await act(async () => {});
    expect(screen.queryByRole("tab", { name: /Organization/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share with Finna" })).toBeNull();
  });

  it("pins the org picker as a static summary once shared", async () => {
    render(<Host organizations={[finna, northwind]} api={collaboration(["ready"])} fileApi={files()} />);
    await openOrganizationTab();
    expect(screen.getByRole("combobox", { name: "Share in Finna, change organization" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Share with Finna" }));
    await screen.findByRole("button", { name: "Copy Finna link" });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("group", { name: "Share in Finna" })).toBeTruthy();
  });

  it("shares an app that isn't collaborative as view-only and keeps the collaborative suggestion", async () => {
    const api = collaboration(["blocked"]);
    render(<Host organizations={[finna]} api={api} fileApi={files()} />);
    await openOrganizationTab();
    const suggestion = await screen.findByRole("region", { name: "Make it collaborative" });
    expect(within(suggestion).getByRole("button", { name: /Start in Chats/ })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Share with Finna" }));
    await screen.findByRole("button", { name: "Copy Finna link" });
    expect(screen.getByText("Shared · View only")).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/share", expect.objectContaining({ organizationId: ORG }));
    expect(within(screen.getByRole("region", { name: "Make it collaborative" })).getByText(/Teammates can view but not edit/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Two steps to share" })).toBeNull();
  });

  it("shows a green tick, not the suggestion, once the app is collaborative", async () => {
    render(<Host organizations={[finna]} api={collaboration([], { initialReadiness: "ready" })} fileApi={files()} />);
    await openOrganizationTab();
    const suggestion = await screen.findByRole("region", { name: "Make it collaborative" });
    expect(await within(suggestion).findByRole("img", { name: "Done" })).toBeTruthy();
    expect(within(suggestion).getByText("Collaborative")).toBeTruthy();
    expect(within(suggestion).queryByRole("button", { name: /Start in Chats/ })).toBeNull();
  });

  it("does not share when the readiness check itself fails", async () => {
    const api = collaboration(["failed"]);
    render(<Host organizations={[finna]} api={api} fileApi={files()} />);
    await openOrganizationTab();
    fireEvent.click(await screen.findByRole("button", { name: "Share with Finna" }));
    expect(await screen.findByText("Couldn’t check this app right now. Try again.")).toBeTruthy();
    expect(api.post).not.toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/share", expect.anything());
  });

  it("starts a new chat with the app, skill, org and request id, then applies the share only after a ready recheck", async () => {
    const api = collaboration(["ready"]);
    const fileApi = files();
    const startChat = vi.fn(async () => true);
    render(<Host organizations={[finna]} api={api} fileApi={fileApi} startChat={startChat} />);
    await openOrganizationTab();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(await screen.findByRole("button", { name: /Start in Chats/ }));
    await waitFor(() => expect(startChat).toHaveBeenCalledTimes(1));
    const record = fileApi.current()!;
    expect(record).toMatchObject({ state: "running", organizationId: ORG, appSlug: "sales-crm", event: "collaborative_app.preparation" });
    const prompt = startChat.mock.calls[0]![0] as string;
    expect(prompt).toContain("/matrix-collaborative-app-builder @Sales CRM");
    expect(prompt).toContain("Finna members will use this app together.");
    expect(prompt).toContain(`organization ${ORG}, request ${record.requestId as string}`);
    expect(await screen.findByText("Setting up…")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open chat/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();

    fileApi.skillWrites({ state: "completed" });
    await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS + 10);
    expect(await screen.findByText("Collaborative and shared")).toBeTruthy();
    expect(screen.queryByText("Everyone at Finna sees the same, live data.")).toBeNull();
    const checks = api.post.mock.calls.filter(([path]) => path.endsWith("/readiness/check"));
    expect(checks).toHaveLength(1);
    expect(fileApi.current()).toMatchObject({ state: "applied" });
  });

  it("keeps sharing off when the skill completes but the app still isn't collaborative", async () => {
    const api = collaboration(["blocked"]);
    const fileApi = files();
    render(<Host organizations={[finna]} api={api} fileApi={fileApi} />);
    await openOrganizationTab();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(await screen.findByRole("button", { name: /Start in Chats/ }));
    await screen.findByText("Setting up…");
    fileApi.skillWrites({ state: "completed" });
    await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS + 10);
    expect(await screen.findByText("Claude finished, but the app isn’t collaborative yet. Open the chat to keep going.")).toBeTruthy();
    expect(api.post).not.toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/share", expect.anything());
    expect(screen.queryByRole("button", { name: "Copy Finna link" })).toBeNull();
  });

  it("does not re-share from an applied record after the owner stopped sharing", async () => {
    const api = collaboration([]);
    const fileApi = files({ version: 1, event: "collaborative_app.preparation", requestId: "50000000-0000-4000-8000-000000000001", appSlug: "sales-crm", organizationId: ORG, state: "applied", updatedAt: "2026-11-15T12:00:00.000Z" });
    render(<Host organizations={[finna]} api={api} fileApi={fileApi} />);
    await openOrganizationTab();
    expect(await screen.findByRole("button", { name: "Share with Finna" })).toBeTruthy();
    await waitFor(() => expect(fileApi.get).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe("Organization tab review fixes", () => {
  const completedRecord = { version: 1, event: "collaborative_app.preparation", requestId: "50000000-0000-4000-8000-000000000001", appSlug: "sales-crm", organizationId: ORG, state: "completed", updatedAt: "2026-11-15T12:00:00.000Z" };

  it("replaces the handoff record on every transition and marks it applied", async () => {
    const api = collaboration(["ready"]);
    const fileApi = files();
    render(<Host organizations={[finna]} api={api} fileApi={fileApi} />);
    await openOrganizationTab();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(await screen.findByRole("button", { name: /Start in Chats/ }));
    await screen.findByText("Setting up…");
    fileApi.skillWrites({ state: "completed" });
    await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS + 10);
    await screen.findByText("Collaborative and shared");
    await waitFor(() => expect(fileApi.current()).toMatchObject({ state: "applied" }));
    expect(fileApi.put.mock.calls.every(([path]) => String(path).includes("force=true"))).toBe(true);
  });

  it("never shares when the owner cancels while the share request is in flight", async () => {
    let release!: () => void;
    const api = collaboration(["ready"], { preflightGate: new Promise((resolve) => { release = resolve; }) });
    render(<Host organizations={[finna]} api={api} fileApi={files(completedRecord)} />);
    await openOrganizationTab();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    release();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/share/preflight", expect.anything()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.post).not.toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/share", expect.anything());
  });

  it("revokes access when the owner cancels after the share request was sent", async () => {
    // Fault: undoing the raced share used a stale share snapshot (null), so stopShare threw and access stayed on.
    let release!: () => void;
    const api = collaboration(["ready"], { shareGate: new Promise((resolve) => { release = resolve; }) });
    render(<Host organizations={[finna]} api={api} fileApi={files(completedRecord)} />);
    await openOrganizationTab();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/share", expect.anything()));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    release();
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/share", expect.objectContaining({ expectedShareRevision: expect.any(String) })));
    expect(screen.queryByText("Collaborative and shared")).toBeNull();
  });

  it("does not re-share from a completion saved before the owner stopped sharing", async () => {
    const stopped = { ...share("stopped"), updatedAt: "2026-11-15T13:00:00.000Z" };
    const api = collaboration(["ready"], { initialShare: stopped });
    render(<Host organizations={[finna]} api={api} fileApi={files(completedRecord)} />);
    await openOrganizationTab();
    expect(await screen.findByRole("button", { name: "Share with Finna" })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.post).not.toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/readiness/check", expect.anything());
  });

  it("never applies a setup that finished for a default app, so no new org share starts", async () => {
    // Fault: a Make-collaborative setup started before default apps went stop-only finishes and
    // creates a brand-new org share for Notes/Calculator through the automatic completion path.
    const api = collaboration(["ready"]);
    const fileApi = files(completedRecord);
    render(<Host organizations={[finna]} api={api} fileApi={fileApi} allowNewSharing={false} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/\/share$/)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.post).not.toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/readiness/check", expect.anything());
    expect(api.post).not.toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/share", expect.anything());
    expect(fileApi.current()).toMatchObject({ state: "completed" });
  });

  it("retries a failed share read so a finished setup still applies", async () => {
    const api = collaboration(["ready"], { shareReadFailures: 1 });
    render(<Host organizations={[finna]} api={api} fileApi={files(completedRecord)} />);
    await openOrganizationTab();
    expect(await screen.findByText("Collaborative and shared")).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/share", expect.anything());
  });
});

// Review fixes (ENG-579): an already-shared app's completion only refreshes readiness, never hides a
// failed check, never overwrites a newer chat; and "View only" is shown only when confirmed.
describe("Organization tab view-only refresh", () => {
  const completed = { version: 1, event: "collaborative_app.preparation", requestId: "50000000-0000-4000-8000-000000000009", appSlug: "sales-crm", organizationId: ORG, state: "completed", updatedAt: "2026-11-25T12:00:00.000Z" };

  it("keeps a completion saved and says so when the refresh check fails", async () => {
    const fileApi = files(completed);
    render(<Host organizations={[finna]} api={collaboration(["failed"], { initialShare: share() })} fileApi={fileApi} />);
    await openOrganizationTab();
    expect(await screen.findByText("Couldn’t check this app right now. Try again.")).toBeTruthy();
    expect(fileApi.current()).toMatchObject({ state: "completed", requestId: completed.requestId });
  });

  it("never overwrites a newer chat request with the older completion", async () => {
    let release!: () => void;
    const api = collaboration(["ready"], { initialShare: share(), checkGate: new Promise((resolve) => { release = resolve; }) });
    const fileApi = files(completed);
    render(<Host organizations={[finna]} api={api} fileApi={fileApi} />);
    await openOrganizationTab();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/readiness/check", expect.anything()));
    fireEvent.click(await screen.findByRole("button", { name: /Start in Chats/ }));
    await waitFor(() => expect(fileApi.current()).toMatchObject({ state: "running" }));
    const newer = fileApi.current()!.requestId;
    release();
    await waitFor(() => expect(screen.getByRole("img", { name: "Done" })).toBeTruthy());
    expect(fileApi.current()).toMatchObject({ state: "running", requestId: newer });
  });

  it("labels a share view-only only when its bound readiness is confirmed blocked", async () => {
    const { unmount } = render(<Host organizations={[finna]} api={collaboration([], { initialShare: share(), readinessReadFails: true })} fileApi={files()} />);
    await openOrganizationTab();
    await screen.findByRole("button", { name: "Copy Finna link" });
    expect(within(screen.getByRole("group", { name: "Share in Finna" })).getByText("Shared")).toBeTruthy();
    expect(screen.queryByText("Shared · View only")).toBeNull();
    unmount();
    render(<Host organizations={[finna]} api={collaboration([], { initialShare: share(), initialReadiness: "blocked" })} fileApi={files()} />);
    await openOrganizationTab();
    expect(await screen.findByText("Shared · View only")).toBeTruthy();
  });

  // Fault: an older "applied" write still in flight landed after a newer Start in Chats record,
  // replacing it on disk and in the UI and stopping completion tracking.
  it("keeps a newer chat request when an older applied write lands late", async () => {
    let release!: () => void;
    const fileApi = files(completed, { firstPutGate: new Promise((resolve) => { release = resolve; }) });
    const api = collaboration(["blocked"], { initialShare: share() });
    render(<Host organizations={[finna]} api={api} fileApi={fileApi} />);
    await openOrganizationTab();
    await waitFor(() => expect(fileApi.put).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: /Start in Chats/ }));
    release();
    await waitFor(() => expect(fileApi.put).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fileApi.current()).toMatchObject({ state: "running" }));
    expect(fileApi.current()!.requestId).not.toBe(completed.requestId);
    expect(await screen.findByText("Setting up…")).toBeTruthy();
  });
});
