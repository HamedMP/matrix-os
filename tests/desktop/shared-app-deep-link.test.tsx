// @vitest-environment jsdom
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSharedAppOpenPath, parseSharedAppDesktopUrl, parseSharedAppOpenParams, sharedAppDesktopUrl, sharedAppDisplayHint, sharedAppOpenPath, sharedAppShareOpenPath } from "@matrix-os/contracts";
import { createDesktopDeepLinkHandler, createSharedAppDeepLinks, registerSharedAppDeepLinkIpc } from "../../desktop/src/main/shared-app-deep-link";
import { CollaborationDirectError } from "../../packages/ui/src/collaboration/direct-client";

// Outcome: a copied org link opens the shared app in the Matrix desktop app.
// Faults: accepting a malformed or foreign deep link, leaking display hints
// into IPC, losing a cold-start link, a non-main window taking the link, a
// link opening an app the member's directory does not list, and the opener
// paging the member's whole directory before opening one linked app.

const SCOPE = "10000000-0000-4000-8000-000000000001";
const BUILD = "b".repeat(64);
const SCHEMES = ["matrixos", "matrix-os"];

const platform = vi.hoisted(() => ({ api: null as { get: (path: string) => Promise<unknown> } | null }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("../../desktop/src/renderer/src/features/collaboration/DesktopCollaborationOrganization", () => ({ useDesktopCollaborationApi: () => platform.api }));
vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({ invoke: vi.fn(async () => ({ link: null })), onEvent: vi.fn(() => () => undefined) }));

describe("org link contract", () => {
  it("round-trips the web hand-off path and the desktop deep link", () => {
    const link = { scopeId: SCOPE, expectedBuildId: BUILD, expectedShareRevision: "3", app: "Sales CRM", org: "Finna" };
    expect(sharedAppOpenPath(link)).toBe(`/open/shared-app/${SCOPE}?expectedBuildId=${BUILD}&expectedShareRevision=3&app=Sales+CRM&org=Finna`);
    const desktop = sharedAppDesktopUrl("matrixos", link);
    expect(desktop).toBe(`matrixos://shared-app/${SCOPE}?expectedBuildId=${BUILD}&expectedShareRevision=3`);
    expect(parseSharedAppDesktopUrl(desktop, SCHEMES)).toEqual({ scopeId: SCOPE, expectedBuildId: BUILD, expectedShareRevision: "3" });
  });

  it("builds the copied org link from a share with the org id hint, and keeps hints out of the desktop link", () => {
    const share = { scopeId: SCOPE, shareRevision: "4", organizationId: "org_2abcDEF123" };
    const path = sharedAppShareOpenPath(share, { app: " <Sales> CRM ", org: "Finna" });
    expect(path).toBe(`/open/shared-app/${SCOPE}?expectedShareRevision=4&app=Sales+CRM&org=Finna&orgId=org_2abcDEF123`);
    const parsed = parseSharedAppOpenParams(SCOPE, Object.fromEntries(new URL(path, "https://app.matrix-os.com").searchParams));
    expect(parsed).toEqual({ scopeId: SCOPE, expectedShareRevision: "4", app: "Sales CRM", org: "Finna", orgId: "org_2abcDEF123" });
    expect(sharedAppDesktopUrl("matrixos", parsed!)).toBe(`matrixos://shared-app/${SCOPE}?expectedShareRevision=4`);
    expect(sharedAppShareOpenPath(share, { app: "<>", org: "" })).toBe(`/open/shared-app/${SCOPE}?expectedShareRevision=4&orgId=org_2abcDEF123`);
  });

  it("still opens links copied before the org id hint existed, and rejects a malformed hint", () => {
    expect(parseSharedAppOpenParams(SCOPE, { expectedShareRevision: "3", app: "Sales", org: "Finna" })).toEqual({ scopeId: SCOPE, expectedShareRevision: "3", app: "Sales", org: "Finna" });
    expect(parseSharedAppOpenParams(SCOPE, { orgId: "Finna" })).toBeNull();
    expect(parseSharedAppDesktopUrl(`matrixos://shared-app/${SCOPE}?orgId=org_2abcDEF123`, SCHEMES)).toBeNull();
  });

  it.each([
    `https://shared-app/${SCOPE}`,
    `matrixos://other/${SCOPE}`,
    "matrixos://shared-app/not-a-uuid",
    `matrixos://shared-app/${SCOPE}/extra`,
    `matrixos://shared-app/${SCOPE}?app=Phish`,
    `matrixos://shared-app/${SCOPE}?expectedBuildId=${BUILD}&expectedBuildId=${BUILD}`,
    `matrixos://shared-app/${SCOPE}#x`,
    `matrixos://user:pass@shared-app/${SCOPE}`,
    "not a url",
    "matrixos://shared-app/%",
  ])("rejects %s", (value) => {
    expect(parseSharedAppDesktopUrl(value, SCHEMES)).toBeNull();
  });

  it("recognizes only the exact public hand-off path", () => {
    expect(isSharedAppOpenPath(`/open/shared-app/${SCOPE}`)).toBe(true);
    expect(isSharedAppOpenPath(`/open/shared-app/${SCOPE}/extra`)).toBe(false);
    expect(isSharedAppOpenPath("/open/shared-app/not-a-scope")).toBe(false);
    expect(isSharedAppOpenPath(`/shared/app/${SCOPE}`)).toBe(false);
  });

  it("sanitizes display hints so they can never break the link", () => {
    expect(sharedAppDisplayHint("  <Sales>\u0007 CRM ")).toBe("Sales CRM");
    expect(sharedAppDisplayHint("<>")).toBeUndefined();
    expect(sharedAppDisplayHint("x".repeat(120))).toHaveLength(80);
  });
});

describe("main-process router", () => {
  it("holds a link until the renderer takes it, then sends later links, and ignores other deep links", () => {
    const send = vi.fn(() => true);
    const router = createSharedAppDeepLinks({ schemes: SCHEMES, send });
    expect(router.handle("matrixos://auth?status=approved")).toBe(false);
    expect(router.handle(`matrixos://shared-app/${SCOPE}`)).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(router.take()).toEqual({ scopeId: SCOPE });
    expect(router.take()).toBeNull();
    router.handle(`matrixos://shared-app/${SCOPE}?expectedShareRevision=2`);
    expect(send).toHaveBeenLastCalledWith({ scopeId: SCOPE, expectedShareRevision: "2" });
    expect(router.take()).toBeNull();
  });

  it("sends a link that arrives while the page still loads once the renderer listens", () => {
    // Fault: gating on webContents.isLoading() stored the link after the renderer's only take, so it never opened.
    const send = vi.fn(() => true);
    const router = createSharedAppDeepLinks({ schemes: SCHEMES, send });
    expect(router.take()).toBeNull();
    router.handle(`matrixos://shared-app/${SCOPE}`);
    expect(send).toHaveBeenCalledWith({ scopeId: SCOPE });
  });

  it("holds links again after the renderer reloads, and when no main window exists", () => {
    let windowAlive = true;
    const send = vi.fn(() => windowAlive);
    const router = createSharedAppDeepLinks({ schemes: SCHEMES, send });
    router.take();
    router.rendererReset();
    router.handle(`matrixos://shared-app/${SCOPE}`);
    expect(send).not.toHaveBeenCalled();
    expect(router.take()).toEqual({ scopeId: SCOPE });
    windowAlive = false;
    router.handle(`matrixos://shared-app/${SCOPE}`);
    expect(router.take()).toEqual({ scopeId: SCOPE });
  });

  it("reopens a closed main window for an org link and holds the link for its renderer", () => {
    // Fault: with only the Terminal window open, focusing a missing main window did nothing and the link never opened.
    let mainOpen = false;
    const focusMainWindow = vi.fn();
    const reopenMainWindow = vi.fn(() => { mainOpen = true; });
    const router = createSharedAppDeepLinks({ schemes: SCHEMES, send: vi.fn(() => true) });
    const handle = createDesktopDeepLinkHandler({
      isDeepLink: (url) => url.startsWith("matrixos://"), hasMainWindow: () => mainOpen,
      focusMainWindow, reopenMainWindow, links: router,
    });
    handle("https://example.com/not-ours");
    expect(reopenMainWindow).not.toHaveBeenCalled();
    handle(`matrixos://shared-app/${SCOPE}`);
    expect(reopenMainWindow).toHaveBeenCalledTimes(1);
    expect(focusMainWindow).not.toHaveBeenCalled();
    expect(router.take()).toEqual({ scopeId: SCOPE });
    handle("matrixos://auth?status=approved");
    expect(focusMainWindow).toHaveBeenCalledTimes(1);
    expect(reopenMainWindow).toHaveBeenCalledTimes(1);
  });

  it("lets only the main window take the pending link", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const take = vi.fn(() => ({ scopeId: SCOPE }));
    const main = { id: "main" };
    registerSharedAppDeepLinkIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, { isMainWindowSender: (event) => event === main, take });
    const handler = handlers.get("deeplink:take-shared-app")!;
    await expect(handler({ id: "terminal" }, {})).rejects.toThrow("invalid request");
    await expect(handler(main, { extra: true })).rejects.toThrow("invalid request");
    expect(take).not.toHaveBeenCalled();
    await expect(handler(main, {})).resolves.toEqual({ link: { scopeId: SCOPE } });
  });
});

describe("renderer opener", () => {
  beforeEach(() => { toastError.mockClear(); platform.api = null; });
  afterEach(cleanup);

  const target = { scopeId: SCOPE, runtimeId: "runtime_owner", organizationId: "org_finna", authorityGeneration: 1, appId: "sales-crm",
    catalogId: "30000000-0000-4000-8000-000000000001", readinessId: "40000000-0000-4000-8000-000000000001",
    registrationIncarnation: "a".repeat(64), buildId: BUILD, shareRevision: "1", owner: { actorId: "user_owner", displayName: "Owner" } };
  const platformWith = (lookup: (path: string) => Promise<unknown>) => {
    const get = vi.fn(lookup);
    platform.api = { get };
    return get;
  };
  const opener = async () => {
    const module = await import("../../desktop/src/renderer/src/features/collaboration/shared-app-deep-links");
    const { useTabs } = await import("../../desktop/src/renderer/src/stores/tabs");
    const { useConnection } = await import("../../desktop/src/renderer/src/stores/connection");
    useConnection.setState({ organizationStatus: "member", organizationId: "org_finna", userId: "user_member" });
    return { ...module, useTabs };
  };

  it("opens a scope with one lookup of that scope instead of paging the directory", async () => {
    const { SharedAppDeepLinkOpener, usePendingSharedAppLink, useTabs } = await opener();
    const get = platformWith(async () => target);
    usePendingSharedAppLink.getState().set({ scopeId: SCOPE });
    render(<SharedAppDeepLinkOpener />);
    await waitFor(() => expect(useTabs.getState().tabs).toEqual(expect.arrayContaining([expect.objectContaining({ sharedAppTarget: target })])));
    expect(get.mock.calls).toEqual([[`/api/collaboration/shared-apps/${SCOPE}`]]);
    expect(usePendingSharedAppLink.getState().link).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("never opens a scope the platform says is not shared with the member", async () => {
    const { SharedAppDeepLinkOpener, usePendingSharedAppLink, NOT_SHARED_WITH_YOU, useTabs } = await opener();
    const before = useTabs.getState().tabs.length;
    platformWith(async () => { throw new CollaborationDirectError("not_found"); });
    usePendingSharedAppLink.getState().set({ scopeId: "10000000-0000-4000-8000-000000000009" });
    render(<SharedAppDeepLinkOpener />);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(NOT_SHARED_WITH_YOU));
    expect(useTabs.getState().tabs.length).toBe(before);
    expect(usePendingSharedAppLink.getState().link).toBeNull();
  });

  it("does not claim no access when the lookup itself fails", async () => {
    const { SharedAppDeepLinkOpener, usePendingSharedAppLink, NOT_SHARED_WITH_YOU, useTabs } = await opener();
    const before = useTabs.getState().tabs.length;
    platformWith(async () => { throw new CollaborationDirectError("unavailable"); });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    usePendingSharedAppLink.getState().set({ scopeId: SCOPE });
    render(<SharedAppDeepLinkOpener />);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn’t open the shared app. Try again."));
    expect(toastError).not.toHaveBeenCalledWith(NOT_SHARED_WITH_YOU);
    expect(useTabs.getState().tabs.length).toBe(before);
  });

  it("waits for a signed-in platform client before looking anything up", async () => {
    const { SharedAppDeepLinkOpener, usePendingSharedAppLink } = await opener();
    platform.api = null;
    usePendingSharedAppLink.getState().set({ scopeId: SCOPE });
    render(<SharedAppDeepLinkOpener />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(toastError).not.toHaveBeenCalled();
    expect(usePendingSharedAppLink.getState().link).toEqual({ scopeId: SCOPE });
    usePendingSharedAppLink.getState().set(null);
  });

  it("rejects a link made before sharing was restarted", async () => {
    const { SharedAppDeepLinkOpener, usePendingSharedAppLink, OUTDATED_LINK, useTabs } = await opener();
    const before = useTabs.getState().tabs.length;
    platformWith(async () => ({ ...target, shareRevision: "2" }));
    usePendingSharedAppLink.getState().set({ scopeId: SCOPE, expectedShareRevision: "1" });
    render(<SharedAppDeepLinkOpener />);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(OUTDATED_LINK));
    expect(useTabs.getState().tabs.length).toBe(before);
  });
});
