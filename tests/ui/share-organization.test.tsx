// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborativeHandoffRecordSchema, type CollaborativeHandoffRecord } from "@matrix-os/contracts";
import { SharePanel, ShareTriggerLabel, useShareController, useShareOrganization, type ShareOrganization, type ShareSiteClient } from "../../packages/ui/src/share/index";
import { HANDOFF_POLL_MS } from "../../packages/ui/src/share/use-collaborative-handoff";

// Outcome: an owner shares a live app with one org from the Organization tab.
// Faults detected: sharing without a passing readiness result, a completion
// event creating a share by itself, the wrong org/request in the Chats
// handoff, and a stale completion re-sharing after Stop sharing.

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
const readiness = (status: "ready" | "blocked", revision = "2") => ({
  readinessId: "40000000-0000-4000-8000-000000000001", build, status, revision,
  checks: codes.map((code) => status === "ready" || code !== "owner_postgres" ? { code, status: "passed" } : { code, status: "blocked", action: "Use shared owner-backed reads in the built app and recheck." }),
  ...(status === "ready" ? { verifiedAt: "2026-11-05T10:00:00.000Z" } : {}),
});
const share = (state: "active" | "stopped" = "active") => ({
  scopeId: "10000000-0000-4000-8000-000000000001", organizationId: ORG,
  owner: { actorId: "user_owner", displayName: "Nima" }, build, readinessId: "40000000-0000-4000-8000-000000000001",
  state, shareRevision: "1", bindingRevision: "1", dataRevision: "0",
  createdAt: "2026-11-05T10:00:00.000Z", updatedAt: "2026-11-05T10:00:00.000Z",
});

function collaboration(checkResults: Array<"ready" | "blocked">, options: {
  initialShare?: unknown;
  preflightGate?: Promise<void>;
  shareGate?: Promise<void>;
  createdShare?: ReturnType<typeof share>;
  shareReadFailures?: number;
} = {}) {
  let current: unknown = null;
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
      return current;
    }),
    post: vi.fn(async (path: string, _body: unknown) => {
      if (path.endsWith("/readiness/check")) { checkCount += 1; current = readiness(results.shift() ?? "blocked", String(checkCount + 1)); return current; }
      if (path.endsWith("/share/preflight")) await options.preflightGate;
      if (path.endsWith("/share/preflight")) return { eligible: true, catalogId: build.catalogId, resourceRevision: "0", readinessId: "40000000-0000-4000-8000-000000000001", buildId: build.buildId, confirmationToken: "token_payload.signature_value" };
      if (path.endsWith("/share")) { currentShare = options.createdShare ?? share(); await options.shareGate; return currentShare; }
      throw new Error(`unexpected ${path}`);
    }),
    delete: vi.fn(async () => { currentShare = { ...share("stopped"), updatedAt: new Date().toISOString() }; return currentShare; }),
  };
}

const HANDOFF_PATH = "system/share/collaborative/sales-crm.json";
const HANDOFF_INTENT_PATH = "system/share/collaborative/sales-crm.intent.json";
const SHARE_PATH = "/api/collaboration/apps/sales-crm/share";
const READINESS_CHECK_PATH = "/api/collaboration/apps/sales-crm/readiness/check";

function filePath(url: string) {
  const path = new URL(url, "https://matrix.test").searchParams.get("path");
  if (!path) throw new Error("Expected a blob path");
  return path;
}

function files(initial: CollaborativeHandoffRecord | null = null) {
  const stored = new Map<string, CollaborativeHandoffRecord>(initial === null ? [] : [[HANDOFF_PATH, initial]]);
  const current = () => stored.get(HANDOFF_INTENT_PATH) ?? stored.get(HANDOFF_PATH) ?? null;
  let nextHandoffRead: Promise<void> | undefined;
  let startWrite: Promise<void> | undefined;
  let cancellationWrite: Promise<void> | undefined;
  return {
    get: vi.fn(async (url: string) => {
      const path = filePath(url);
      const snapshot = stored.get(path);
      if (path === HANDOFF_PATH && nextHandoffRead) {
        const gate = nextHandoffRead;
        nextHandoffRead = undefined;
        await gate;
      }
      if (snapshot === undefined) throw Object.assign(new Error("missing"), { category: "notFound" });
      return snapshot;
    }),
    // Mirrors the gateway blob route: replacing an existing file needs force=true.
    put: vi.fn(async (path: string, body: unknown) => {
      const key = filePath(path);
      if (stored.has(key) && !path.includes("force=true")) throw Object.assign(new Error("file_exists"), { status: 409 });
      const record = CollaborativeHandoffRecordSchema.parse(body);
      if (record.state === "running" && startWrite) await startWrite;
      if (record.state === "cancelled" && cancellationWrite) await cancellationWrite;
      stored.set(key, record);
      return { ok: true };
    }),
    holdNextHandoffRead: (gate: Promise<void>) => { nextHandoffRead = gate; },
    holdStartWrite: (gate: Promise<void>) => { startWrite = gate; },
    holdCancellationWrite: (gate: Promise<void>) => { cancellationWrite = gate; },
    legacyRecord: () => stored.get(HANDOFF_PATH),
    /** Simulates the builder skill rewriting the record. */
    skillWrites: (patch: Partial<CollaborativeHandoffRecord>) => {
      const outcome = CollaborativeHandoffRecordSchema.parse({ ...current(), ...patch, updatedAt: "2026-11-15T12:00:00.000Z" });
      stored.set(HANDOFF_PATH, outcome);
    },
    current,
  };
}

const site: ShareSiteClient = {
  get: vi.fn(async () => null), deploy: vi.fn(), update: vi.fn(), unpublish: vi.fn(), getConfig: vi.fn(),
  accessLinks: vi.fn(), createAccessLink: vi.fn(), revokeAccessLink: vi.fn(),
  slugAvailability: vi.fn(async () => ({ status: "available" as const, suggestions: [] })),
};

function Host({ organizations, api, fileApi, startChat = vi.fn(async () => true) }: {
  organizations: ShareOrganization[]; api: ReturnType<typeof collaboration>; fileApi: ReturnType<typeof files>; startChat?: (prompt: string) => Promise<boolean>;
}) {
  const controller = useShareController({ appSlug: "sales-crm", appName: "Sales CRM", client: site, emailInvites: null });
  const organization = useShareOrganization({
    appSlug: "sales-crm", appName: "Sales CRM", organizations, preferredOrganizationId: ORG,
    collaborationApi: api, fileApi, startChat, openChat: vi.fn(),
    orgLink: (value, hints) => `https://app.matrix-os.com/open/shared-app/${value.scopeId}?app=${hints.app}`,
  });
  return <>
    <span data-testid="trigger"><ShareTriggerLabel pageMode={controller.pageMode} orgShared={organization.shared} /></span>
    <SharePanel share={controller} appSlug="sales-crm" appName="Sales CRM" client={site} ownerInitial="N" onClose={vi.fn()} organization={organization.slot} />
  </>;
}
const openOrganizationTab = async () => fireEvent.mouseDown(await screen.findByRole("tab", { name: /Organization/ }), { button: 0 });

afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); });

describe("Organization tab", () => {
  it("is hidden when the owner belongs to no organization", async () => {
    render(<Host organizations={[]} api={collaboration([])} fileApi={files()} />);
    await screen.findByRole("tab", { name: /Private/ });
    expect(screen.queryByRole("tab", { name: /Organization/ })).toBeNull();
  });

  it("shows a static org with one membership and a picker with several", async () => {
    const { unmount } = render(<Host organizations={[finna]} api={collaboration([])} fileApi={files()} />);
    await openOrganizationTab();
    expect(screen.getByLabelText("Share in Finna")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("24 members")).toBeTruthy();
    unmount();
    render(<Host organizations={[finna, northwind]} api={collaboration([])} fileApi={files()} />);
    await openOrganizationTab();
    expect(screen.getByRole("combobox", { name: "Share in Finna, change organization" })).toBeTruthy();
  });

  it("shares immediately when readiness passes, then stops sharing", async () => {
    const api = collaboration(["ready"]);
    render(<Host organizations={[finna]} api={api} fileApi={files()} />);
    await openOrganizationTab();
    expect(screen.getByText("Members open and use the live app from their launcher.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Share with Finna" }));
    expect(await screen.findByText("Finna link")).toBeTruthy();
    expect(screen.getByText("Shared — it’s in every Finna member’s launcher.")).toBeTruthy();
    expect(screen.getByTestId("trigger").textContent).toBe("Shared");
    expect(within(screen.getByRole("tab", { name: /Organization/ })).getByRole("img", { name: "on" })).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/share/preflight", expect.objectContaining({ organizationId: ORG }));
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing with Finna" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Share with Finna" })).toBeTruthy();
  });

  it("pins the org picker as a static summary once shared", async () => {
    render(<Host organizations={[finna, northwind]} api={collaboration(["ready"])} fileApi={files()} />);
    await openOrganizationTab();
    expect(screen.getByRole("combobox", { name: "Share in Finna, change organization" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Share with Finna" }));
    await screen.findByText("Finna link");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByLabelText("Share in Finna")).toBeTruthy();
  });

  it("asks for the two-step collaborative flow when readiness is blocked and never shares", async () => {
    const api = collaboration(["blocked"]);
    render(<Host organizations={[finna]} api={api} fileApi={files()} />);
    await openOrganizationTab();
    fireEvent.click(await screen.findByRole("button", { name: "Share with Finna" }));
    expect(await screen.findByRole("list", { name: "Two steps to share" })).toBeTruthy();
    expect(screen.getByText("This app saves data, so sharing takes two quick steps.")).toBeTruthy();
    expect(screen.getByText("Turns on by itself when step 1 is done.")).toBeTruthy();
    expect(api.post).not.toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/share", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Share with Finna" })).toBeTruthy();
  });

  it("starts a new chat with the app, skill, org and request id, then applies the share only after a ready recheck", async () => {
    const api = collaboration(["blocked", "ready"]);
    const fileApi = files();
    const startChat = vi.fn(async () => true);
    render(<Host organizations={[finna]} api={api} fileApi={fileApi} startChat={startChat} />);
    await openOrganizationTab();
    fireEvent.click(await screen.findByRole("button", { name: "Share with Finna" }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(await screen.findByRole("button", { name: /Start in Chats/ }));
    await waitFor(() => expect(startChat).toHaveBeenCalledTimes(1));
    const record = fileApi.current()!;
    expect(record).toMatchObject({ state: "running", organizationId: ORG, appSlug: "sales-crm", event: "collaborative_app.preparation" });
    const prompt = startChat.mock.calls[0]![0] as string;
    expect(prompt).toContain("/matrix-collaborative-app-builder @Sales CRM");
    expect(prompt).toContain("Finna members will use this app together.");
    expect(prompt).toContain(`organization ${ORG}, request ${record.requestId}`);
    expect(await screen.findByText("Claude is setting it up in a new chat.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open chat/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel sharing" })).toBeTruthy();

    fileApi.skillWrites({ state: "completed" });
    await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS + 10);
    expect(await screen.findByText("Collaborative and shared")).toBeTruthy();
    expect(screen.getByText("Everyone at Finna sees the same, live data.")).toBeTruthy();
    const checks = api.post.mock.calls.filter(([path]) => path.endsWith("/readiness/check"));
    expect(checks).toHaveLength(2);
    expect(fileApi.current()).toMatchObject({ state: "applied" });
  });

  it("keeps sharing off when the skill completes but readiness still fails", async () => {
    const api = collaboration(["blocked", "blocked"]);
    const fileApi = files();
    render(<Host organizations={[finna]} api={api} fileApi={fileApi} />);
    await openOrganizationTab();
    fireEvent.click(await screen.findByRole("button", { name: "Share with Finna" }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(await screen.findByRole("button", { name: /Start in Chats/ }));
    await screen.findByText("Claude is setting it up in a new chat.");
    fileApi.skillWrites({ state: "completed" });
    await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS + 10);
    expect(await screen.findByText("Claude finished, but the app isn’t ready to share yet. Open the chat to keep going.")).toBeTruthy();
    expect(api.post).not.toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/share", expect.anything());
    expect(screen.queryByText("Finna link")).toBeNull();
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
  const completedRecord: CollaborativeHandoffRecord = { version: 1, event: "collaborative_app.preparation", requestId: "50000000-0000-4000-8000-000000000001", appSlug: "sales-crm", organizationId: ORG, state: "completed", updatedAt: "2026-11-15T12:00:00.000Z" };

  it("saves cancellation for clients that still read the legacy handoff file", async () => {
    const api = collaboration(["ready"]);
    const fileApi = files({ ...completedRecord, state: "running" });
    render(<Host organizations={[finna]} api={api} fileApi={fileApi} />);
    await openOrganizationTab();
    const cancel = await screen.findByRole("button", { name: "Cancel sharing" });
    fileApi.skillWrites({ state: "completed" });
    await act(async () => { fireEvent.click(cancel); });

    expect(fileApi.legacyRecord()).toMatchObject({ requestId: completedRecord.requestId, state: "cancelled" });
    expect(api.post).not.toHaveBeenCalledWith(SHARE_PATH, expect.anything());
  });

  it("does not replace a different request in the legacy handoff file when cancelling", async () => {
    const api = collaboration(["ready"]);
    const fileApi = files({ ...completedRecord, state: "running" });
    render(<Host organizations={[finna]} api={api} fileApi={fileApi} />);
    await openOrganizationTab();
    const cancel = await screen.findByRole("button", { name: "Cancel sharing" });
    const newerRequestId = "50000000-0000-4000-8000-000000000002";
    fileApi.skillWrites({ state: "running", requestId: newerRequestId });
    await act(async () => { fireEvent.click(cancel); });

    expect(fileApi.current()).toMatchObject({ requestId: completedRecord.requestId, state: "cancelled" });
    expect(fileApi.legacyRecord()).toMatchObject({ requestId: newerRequestId, state: "running" });
  });

  it("does not recheck or share when a completed poll arrives before Cancel is saved", async () => {
    vi.useFakeTimers();
    const api = collaboration(["ready"]);
    const fileApi = files({ ...completedRecord, state: "running" });
    const poll = Promise.withResolvers<void>();
    const cancelWrite = Promise.withResolvers<void>();
    fileApi.holdCancellationWrite(cancelWrite.promise);
    render(<Host organizations={[finna]} api={api} fileApi={fileApi} />);
    await act(async () => {});
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Organization/ }), { button: 0 });
    const cancel = screen.getByRole("button", { name: "Cancel sharing" });

    fileApi.skillWrites({ state: "completed" });
    fileApi.holdNextHandoffRead(poll.promise);
    fileApi.get.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS); });
    expect(fileApi.get.mock.calls.some(([path]) => filePath(path) === HANDOFF_PATH)).toBe(true);
    fireEvent.click(cancel);
    expect(fileApi.put).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ state: "cancelled" }));

    await act(async () => { poll.resolve(); });
    expect(api.post).not.toHaveBeenCalledWith(SHARE_PATH, expect.anything());
    expect(api.post).not.toHaveBeenCalledWith(READINESS_CHECK_PATH, expect.anything());
    await act(async () => { cancelWrite.resolve(); });
  });

  it("ignores a late builder completion on a fresh mount after Cancel was saved", async () => {
    const api = collaboration(["ready"]);
    const fileApi = files({ ...completedRecord, state: "running" });
    const host = <Host organizations={[finna]} api={api} fileApi={fileApi} />;
    const view = render(host);
    await openOrganizationTab();
    const cancel = await screen.findByRole("button", { name: "Cancel sharing" });
    await act(async () => { fireEvent.click(cancel); });
    expect(fileApi.put).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ state: "cancelled" }));
    view.unmount();

    // The same owner runtime is reopened from a client with no browser state.
    localStorage.clear();
    sessionStorage.clear();
    fileApi.skillWrites(completedRecord);
    render(host);
    await act(async () => {});
    expect(api.post).not.toHaveBeenCalledWith(SHARE_PATH, expect.anything());
    expect(api.post).not.toHaveBeenCalledWith(READINESS_CHECK_PATH, expect.anything());
  });

  it("ignores a builder completion when remounted before Cancel is saved", async () => {
    const api = collaboration(["ready"]);
    const fileApi = files({ ...completedRecord, state: "running" });
    const cancelWrite = Promise.withResolvers<void>();
    fileApi.holdCancellationWrite(cancelWrite.promise);
    const host = <Host organizations={[finna]} api={api} fileApi={fileApi} />;
    const view = render(host);
    await openOrganizationTab();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel sharing" }));
    expect(fileApi.put).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ state: "cancelled" }));
    view.unmount();

    fileApi.skillWrites(completedRecord);
    render(host);
    await act(async () => {});
    expect(api.post).not.toHaveBeenCalledWith(SHARE_PATH, expect.anything());
    expect(api.post).not.toHaveBeenCalledWith(READINESS_CHECK_PATH, expect.anything());
    await act(async () => { cancelWrite.resolve(); });
  });

  it("honors a cancellation saved by another renderer while the builder result is being read", async () => {
    const api = collaboration(["ready"]);
    const fileApi = files(completedRecord);
    const resultRead = Promise.withResolvers<void>();
    fileApi.holdNextHandoffRead(resultRead.promise);
    render(<Host organizations={[finna]} api={api} fileApi={fileApi} />);
    await waitFor(() => expect(fileApi.get).toHaveBeenCalledWith(
      `/api/files/blob?path=${encodeURIComponent(HANDOFF_PATH)}`, expect.anything(),
    ));
    await fileApi.put(`/api/files/blob?path=${encodeURIComponent(HANDOFF_INTENT_PATH)}&force=true`, {
      ...completedRecord, state: "cancelled",
    });
    await act(async () => { resultRead.resolve(); });
    expect(api.post).not.toHaveBeenCalledWith(READINESS_CHECK_PATH, expect.anything());
    expect(api.post).not.toHaveBeenCalledWith(SHARE_PATH, expect.anything());
  });

  it("retires a handoff when Cancel is clicked before the start write returns", async () => {
    const api = collaboration(["blocked", "ready"]);
    const fileApi = files();
    const startWrite = Promise.withResolvers<void>();
    const startChat = vi.fn(async () => true);
    fileApi.holdStartWrite(startWrite.promise);
    render(<Host organizations={[finna]} api={api} fileApi={fileApi} startChat={startChat} />);
    await openOrganizationTab();
    fireEvent.click(await screen.findByRole("button", { name: "Share with Finna" }));
    fireEvent.click(await screen.findByRole("button", { name: /Start in Chats/ }));
    expect(fileApi.put).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ state: "running" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await act(async () => { startWrite.resolve(); });
    expect(startChat).not.toHaveBeenCalled();
    expect(fileApi.current()).toMatchObject({ state: "cancelled" });
    expect(await screen.findByRole("button", { name: "Share with Finna" })).toBeTruthy();
  });

  it("applies a new handoff after Cancel, even if the old completion arrived last before remount", async () => {
    const api = collaboration(["blocked", "ready"]);
    const fileApi = files({ ...completedRecord, state: "running" });
    const startChat = vi.fn(async () => true);
    const host = <Host organizations={[finna]} api={api} fileApi={fileApi} startChat={startChat} />;
    const view = render(host);
    await openOrganizationTab();
    const cancel = await screen.findByRole("button", { name: "Cancel sharing" });
    await act(async () => { fireEvent.click(cancel); });
    fireEvent.click(await screen.findByRole("button", { name: "Share with Finna" }));
    fireEvent.click(await screen.findByRole("button", { name: /Start in Chats/ }));
    await waitFor(() => expect(startChat).toHaveBeenCalledTimes(1));
    const newRequest = fileApi.current()!.requestId;
    expect(newRequest).not.toBe(completedRecord.requestId);
    view.unmount();

    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
    fileApi.skillWrites(completedRecord);
    render(host);
    await act(async () => {});
    expect(api.post).not.toHaveBeenCalledWith(SHARE_PATH, expect.anything());
    expect(api.post.mock.calls.filter(([path]) => path === READINESS_CHECK_PATH)).toHaveLength(1);

    fileApi.skillWrites({ state: "completed", requestId: newRequest });
    await act(async () => { await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS); });
    expect(api.post).toHaveBeenCalledWith(SHARE_PATH, expect.objectContaining({ organizationId: ORG }));
    expect(api.post.mock.calls.filter(([path]) => path === SHARE_PATH)).toHaveLength(1);
    expect(fileApi.current()).toMatchObject({ requestId: newRequest, state: "applied" });
  });

  it("replaces the handoff record on every transition and marks it applied", async () => {
    const api = collaboration(["blocked", "ready"]);
    const fileApi = files();
    render(<Host organizations={[finna]} api={api} fileApi={fileApi} />);
    await openOrganizationTab();
    fireEvent.click(await screen.findByRole("button", { name: "Share with Finna" }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(await screen.findByRole("button", { name: /Start in Chats/ }));
    await screen.findByText("Claude is setting it up in a new chat.");
    fileApi.skillWrites({ state: "completed" });
    await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS + 10);
    await screen.findByText("Collaborative and shared");
    await waitFor(() => expect(fileApi.current()).toMatchObject({ state: "applied" }));
    expect(fileApi.put.mock.calls.every(([path]) => String(path).includes("force=true"))).toBe(true);
  });

  it("never sends the share POST when the owner cancels while preflight is in flight", async () => {
    const preflight = Promise.withResolvers<void>();
    const api = collaboration(["ready"], { preflightGate: preflight.promise });
    render(<Host organizations={[finna]} api={api} fileApi={files(completedRecord)} />);
    await openOrganizationTab();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${SHARE_PATH}/preflight`, expect.anything()));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel sharing" }));
    await act(async () => { preflight.resolve(); });
    expect(api.post).not.toHaveBeenCalledWith(SHARE_PATH, expect.anything());
  });

  it("revokes access when the owner cancels after the share request was sent", async () => {
    // Fault: undoing the raced share used a stale share snapshot (null), so stopShare threw and access stayed on.
    const sharePost = Promise.withResolvers<void>();
    const createdShare = { ...share(), shareRevision: "7", bindingRevision: "11" };
    const api = collaboration(["ready"], { shareGate: sharePost.promise, createdShare });
    render(<Host organizations={[finna]} api={api} fileApi={files(completedRecord)} />);
    await openOrganizationTab();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(SHARE_PATH, expect.anything()));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel sharing" }));
    expect(api.delete).not.toHaveBeenCalled();
    await act(async () => { sharePost.resolve(); });
    expect(api.delete).toHaveBeenCalledExactlyOnceWith(SHARE_PATH, expect.objectContaining({
      expectedShareRevision: "7",
      expectedBindingRevision: "11",
    }));
    expect(await screen.findByRole("button", { name: "Share with Finna" })).toBeTruthy();
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

  it("retries a failed share read so a finished setup still applies", async () => {
    const api = collaboration(["ready"], { shareReadFailures: 1 });
    render(<Host organizations={[finna]} api={api} fileApi={files(completedRecord)} />);
    await openOrganizationTab();
    expect(await screen.findByText("Collaborative and shared")).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith("/api/collaboration/apps/sales-crm/share", expect.anything());
  });
});
