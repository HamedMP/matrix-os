// @vitest-environment jsdom
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSharedAppDesktopUrl, sharedAppDesktopUrl, sharedAppDisplayHint, sharedAppOpenPath } from "@matrix-os/contracts";
import { createDesktopDeepLinkHandler, createSharedAppDeepLinks, registerSharedAppDeepLinkIpc } from "../../desktop/src/main/shared-app-deep-link";

// Outcome: a copied org link opens the shared app in the Matrix desktop app.
// Faults: accepting a malformed or foreign deep link, leaking display hints
// into IPC, losing a cold-start link, a non-main window taking the link, and a
// link opening an app the member's directory does not list.

const SCOPE = "10000000-0000-4000-8000-000000000001";
const BUILD = "b".repeat(64);
const SCHEMES = ["matrixos", "matrix-os"];

const directory = vi.hoisted(() => ({ value: { items: [] as unknown[], loaded: false, unavailable: false, hasMore: false, loading: false, loadMore: (() => undefined) as () => void } }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("../../desktop/src/renderer/src/features/collaboration/useSharedLauncherApps", () => ({ useSharedLauncherApps: () => directory.value }));
vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({ invoke: vi.fn(async () => ({ link: null })), onEvent: vi.fn(() => () => undefined) }));

describe("org link contract", () => {
  it("round-trips the web hand-off path and the desktop deep link", () => {
    const link = { scopeId: SCOPE, expectedBuildId: BUILD, expectedShareRevision: "3", app: "Sales CRM", org: "Finna" };
    expect(sharedAppOpenPath(link)).toBe(`/open/shared-app/${SCOPE}?expectedBuildId=${BUILD}&expectedShareRevision=3&app=Sales+CRM&org=Finna`);
    const desktop = sharedAppDesktopUrl("matrixos", link);
    expect(desktop).toBe(`matrixos://shared-app/${SCOPE}?expectedBuildId=${BUILD}&expectedShareRevision=3`);
    expect(parseSharedAppDesktopUrl(desktop, SCHEMES)).toEqual({ scopeId: SCOPE, expectedBuildId: BUILD, expectedShareRevision: "3" });
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
  beforeEach(() => { toastError.mockClear(); directory.value = { items: [], loaded: false, unavailable: false, hasMore: false, loading: false, loadMore: () => undefined }; });
  afterEach(cleanup);

  const target = { scopeId: SCOPE, runtimeId: "runtime_owner", organizationId: "org_finna", authorityGeneration: 1, appId: "sales-crm",
    catalogId: "30000000-0000-4000-8000-000000000001", readinessId: "40000000-0000-4000-8000-000000000001",
    registrationIncarnation: "a".repeat(64), buildId: BUILD, shareRevision: "1", owner: { actorId: "user_owner", displayName: "Owner" } };

  it("opens a scope the member's directory lists", async () => {
    const { SharedAppDeepLinkOpener, usePendingSharedAppLink } = await import("../../desktop/src/renderer/src/features/collaboration/shared-app-deep-links");
    const { useTabs } = await import("../../desktop/src/renderer/src/stores/tabs");
    const { useConnection } = await import("../../desktop/src/renderer/src/stores/connection");
    useConnection.setState({ organizationStatus: "member", organizationId: "org_finna" });
    directory.value = { ...directory.value, items: [target], loaded: true };
    usePendingSharedAppLink.getState().set({ scopeId: SCOPE });
    render(<SharedAppDeepLinkOpener />);
    await waitFor(() => expect(useTabs.getState().tabs).toEqual(expect.arrayContaining([expect.objectContaining({ sharedAppTarget: target })])));
    expect(usePendingSharedAppLink.getState().link).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("never opens a scope the directory does not list", async () => {
    const { SharedAppDeepLinkOpener, usePendingSharedAppLink, NOT_SHARED_WITH_YOU } = await import("../../desktop/src/renderer/src/features/collaboration/shared-app-deep-links");
    const { useTabs } = await import("../../desktop/src/renderer/src/stores/tabs");
    const { useConnection } = await import("../../desktop/src/renderer/src/stores/connection");
    useConnection.setState({ organizationStatus: "member", organizationId: "org_finna" });
    const before = useTabs.getState().tabs.length;
    directory.value = { ...directory.value, items: [], loaded: true };
    usePendingSharedAppLink.getState().set({ scopeId: "10000000-0000-4000-8000-000000000009" });
    render(<SharedAppDeepLinkOpener />);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(NOT_SHARED_WITH_YOU));
    expect(useTabs.getState().tabs.length).toBe(before);
  });

  it("keeps paging the directory before treating a scope as not shared", async () => {
    const { SharedAppDeepLinkOpener, usePendingSharedAppLink } = await import("../../desktop/src/renderer/src/features/collaboration/shared-app-deep-links");
    const { useConnection } = await import("../../desktop/src/renderer/src/stores/connection");
    useConnection.setState({ organizationStatus: "member", organizationId: "org_finna" });
    const loadMore = vi.fn();
    directory.value = { ...directory.value, items: [], loaded: true, hasMore: true, loadMore };
    usePendingSharedAppLink.getState().set({ scopeId: SCOPE });
    render(<SharedAppDeepLinkOpener />);
    await waitFor(() => expect(loadMore).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalled();
    expect(usePendingSharedAppLink.getState().link).toEqual({ scopeId: SCOPE });
    usePendingSharedAppLink.getState().set(null);
  });

  it("rejects a link made before sharing was restarted", async () => {
    const { SharedAppDeepLinkOpener, usePendingSharedAppLink, OUTDATED_LINK } = await import("../../desktop/src/renderer/src/features/collaboration/shared-app-deep-links");
    const { useTabs } = await import("../../desktop/src/renderer/src/stores/tabs");
    const { useConnection } = await import("../../desktop/src/renderer/src/stores/connection");
    useConnection.setState({ organizationStatus: "member", organizationId: "org_finna" });
    const before = useTabs.getState().tabs.length;
    directory.value = { ...directory.value, items: [{ ...target, shareRevision: "2" }], loaded: true };
    usePendingSharedAppLink.getState().set({ scopeId: SCOPE, expectedShareRevision: "1" });
    render(<SharedAppDeepLinkOpener />);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(OUTDATED_LINK));
    expect(useTabs.getState().tabs.length).toBe(before);
  });
});
