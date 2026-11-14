// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborativeAppDirectoryItem } from "@matrix-os/contracts";

const mocks = vi.hoisted(() => ({
  createApi: vi.fn(),
  releaseApi: vi.fn(),
  createTransport: vi.fn(),
  sharedViewer: vi.fn(),
  shareButton: vi.fn(),
  organization: vi.fn().mockReturnValue({ status: "unknown", organizationId: null, organizationName: null }),
  openSession: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn().mockReturnValue(() => undefined),
  ownerShareGet: vi.fn(),
}));

vi.mock("@/hooks/useBrowserOrigin", () => ({ useBrowserOrigin: () => "https://app.matrix-os.test" }));
vi.mock("@/lib/collaboration", () => ({
  createShellCollaborationApi: mocks.createApi,
  releaseShellCollaborationApi: mocks.releaseApi,
}));
vi.mock("@matrix-os/ui/collaborative-app-sharing", async (importOriginal) => ({
  // Window titles use the real shared presentation derivation.
  sharedAppPresentation: (await importOriginal<typeof import("@matrix-os/ui/collaborative-app-sharing")>()).sharedAppPresentation,
  CollaborativeAppShareButton: (props: unknown) => { mocks.shareButton(props); return null; },
  ReadinessSummary: () => null,
  useCollaborativeAppSharing: () => ({ readiness: null }),
  createSharedAppTransport: mocks.createTransport,
  SharedAppViewer: (props: { target: CollaborativeAppDirectoryItem; transport: unknown }) => {
    mocks.sharedViewer(props);
    return <div data-testid="shared-app-viewer">{props.target.scopeId}</div>;
  },
}));
vi.mock("@/api/http", () => ({ shellApi: { get: mocks.ownerShareGet } }));
vi.mock("@/hooks/useFileWatcher", () => ({ useFileWatcher: vi.fn() }));
vi.mock("@/hooks/useSocket", () => ({
  useSocket: () => ({ send: vi.fn(), subscribe: mocks.subscribe }),
}));
vi.mock("@/lib/app-session", () => ({ openAppSession: mocks.openSession }));
vi.mock("@/lib/collaboration-organization-state", () => ({
  useCollaborationOrganization: mocks.organization,
}));

import { AppViewer } from "../../shell/src/components/AppViewer.js";
import { OwnerCollaborationParticipantProvider } from "../../shell/src/lib/owner-collaboration-participant.js";
import {
  sharedAppDeepLink,
  sharedAppWindowPath,
  sharedAppWindowTitle,
} from "../../shell/src/lib/shared-app-target.js";

const target: CollaborativeAppDirectoryItem = {
  scopeId: "10000000-0000-4000-8000-000000000001",
  runtimeId: "vps:20000000-0000-4000-8000-000000000001",
  organizationId: "org_matrix_team",
  authorityGeneration: 1,
  appId: "tracker",
  catalogId: "30000000-0000-4000-8000-000000000001",
  readinessId: "40000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64),
  buildId: "b".repeat(64),
  shareRevision: "1",
  owner: { actorId: "user_owner", displayName: "Nima" },
};

function ownerShare() {
  return {
    scopeId: target.scopeId,
    organizationId: target.organizationId,
    owner: target.owner,
    build: {
      appId: target.appId,
      catalogId: target.catalogId,
      registrationIncarnation: target.registrationIncarnation,
      manifestVersion: "1.0.0",
      buildId: target.buildId,
      manifestDigest: "c".repeat(64),
      schemaDigest: "d".repeat(64),
      assetDigest: "e".repeat(64),
      bridgeContractVersion: "1",
      runtimeAbi: "1",
    },
    readinessId: target.readinessId,
    state: "active",
    shareRevision: "1",
    bindingRevision: "1",
    dataRevision: "2",
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:00.000Z",
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.organization.mockReturnValue({ status: "unknown", organizationId: null, organizationName: null });
});

describe("collaborative app web viewer", () => {
  it("keeps the member viewer on an open client after Strict Mode replays effects", async () => {
    mocks.createApi.mockImplementation(() => ({
      get: vi.fn(),
      direct: { closed: false, close() { this.closed = true; } },
    }));
    mocks.releaseApi.mockImplementation((api: { direct: { close(): void } }) => api.direct.close());
    mocks.createTransport.mockImplementation(({ direct }: { direct: { closed: boolean } }) => ({ direct }));

    render(<React.StrictMode><AppViewer path="__shared-app__:tracker" sharedAppTarget={target} /></React.StrictMode>);

    await waitFor(() => expect(mocks.sharedViewer).toHaveBeenCalled());
    const { transport } = mocks.sharedViewer.mock.lastCall![0] as { transport: { direct: { closed: boolean } } };
    expect(transport.direct.closed).toBe(false);
  });

  it("derives one stable window identity and an exact-build fallback link", () => {
    expect(sharedAppWindowPath(target)).toBe(`__shared-app__:${target.scopeId}`);
    expect(sharedAppWindowTitle(target)).toBe("Tracker shared by Nima");
    expect(sharedAppDeepLink(target)).toBe(
      `/shared/app/${target.scopeId}?expectedBuildId=${target.buildId}&expectedShareRevision=1`,
    );
  });

  it("routes an exact shared target through the restricted shared transport, never the owner bridge", async () => {
    const direct = { request: vi.fn(), subscribeEvents: vi.fn(), close: vi.fn() };
    const api = { direct };
    const transport = { target };
    mocks.createApi.mockReturnValue(api);
    mocks.createTransport.mockReturnValue(transport);

    const view = render(
      <AppViewer path={`__shared-app__:${target.scopeId}`} sharedAppTarget={target} />,
    );

    expect((await screen.findByTestId("shared-app-viewer")).textContent).toBe(target.scopeId);
    expect(mocks.createApi).toHaveBeenCalledWith("https://app.matrix-os.test");
    expect(mocks.createTransport).toHaveBeenCalledWith({ platform: api, direct, target });

    view.unmount();
    expect(mocks.releaseApi).toHaveBeenCalledWith(api);
  });

  it("keeps the transport and mounted viewer stable when discovery returns an equivalent target", async () => {
    const direct = { request: vi.fn(), subscribeEvents: vi.fn(), close: vi.fn() };
    const api = { direct };
    const transport = { target };
    mocks.createApi.mockReturnValue(api);
    mocks.createTransport.mockReturnValue(transport);
    const view = render(
      <AppViewer path={`__shared-app__:${target.scopeId}`} sharedAppTarget={target} />,
    );
    await screen.findByTestId("shared-app-viewer");

    view.rerender(<AppViewer path={`__shared-app__:${target.scopeId}`} sharedAppTarget={{
      ...target,
      owner: { ...target.owner },
    }} />);

    expect(mocks.createTransport).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.sharedViewer).toHaveBeenLastCalledWith({ target, transport }));
  });

  it("routes collaboration requests from an owner app iframe after StrictMode effect replay", async () => {
    const direct = {
      request: vi.fn().mockResolvedValue({ result: { id: "tracker" }, revision: "2" }),
      subscribeEvents: vi.fn().mockReturnValue(() => undefined),
      close: vi.fn(),
    };
    mocks.ownerShareGet.mockResolvedValue(ownerShare());
    const platformGet = vi.fn();
    mocks.createApi.mockReturnValue({ get: platformGet, direct });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html><head></head><body></body></html>")));

    const view = render(<OwnerCollaborationParticipantProvider actorId="user_owner">
      <React.StrictMode><AppViewer path="matrix-app:tracker" /></React.StrictMode>
    </OwnerCollaborationParticipantProvider>);
    const iframe = screen.getByTitle("matrix-app:tracker") as HTMLIFrameElement;
    await waitFor(() => expect(iframe.srcdoc).toContain('"actorId":"user_owner"'));
    const postMessage = vi.fn();
    const close = vi.fn();
    const event = new MessageEvent("message", {
      data: {
        type: "os:collaboration-request",
        app: "tracker",
        payload: { kind: "query", action: { action: "appInfo" } },
      },
      origin: "null",
      source: iframe.contentWindow,
    });
    Object.defineProperty(event, "ports", { value: [{ postMessage, close }] });
    window.dispatchEvent(event);

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      ok: true,
      value: { result: { id: "tracker" }, revision: "2" },
    }));
    expect(direct.request).toHaveBeenCalledWith(target.scopeId, "POST",
      `/api/collaboration/scopes/${target.scopeId}/apps/tracker/view`,
      { action: { action: "appInfo", app: "tracker" } }, undefined, expect.any(AbortSignal));
    expect(mocks.ownerShareGet).toHaveBeenCalledWith("/api/collaboration/apps/tracker/share", expect.anything());
    expect(platformGet).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(mocks.releaseApi).toHaveBeenCalled();
  });

  it("keeps owner collaboration usable after Strict Mode replays effect setup", async () => {
    const requests: ReturnType<typeof vi.fn>[] = [];
    mocks.ownerShareGet.mockResolvedValue(ownerShare());
    mocks.createApi.mockImplementation(() => {
      let closed = false;
      const direct = {
        request: vi.fn().mockImplementation(async () => {
          if (closed) throw new Error("Direct client closed");
          return { result: { id: "tracker" }, revision: "2" };
        }),
        subscribeEvents: vi.fn().mockReturnValue(() => undefined),
        close: vi.fn(() => { closed = true; }),
      };
      requests.push(direct.request);
      return { get: vi.fn(), direct };
    });
    mocks.releaseApi.mockImplementation((api: { direct: { close(): void } }) => api.direct.close());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html><head></head><body></body></html>")));

    render(<React.StrictMode><AppViewer path="matrix-app:tracker" /></React.StrictMode>);
    const iframe = screen.getByTitle("matrix-app:tracker") as HTMLIFrameElement;
    const postMessage = vi.fn();
    const event = new MessageEvent("message", {
      data: { type: "os:collaboration-request", app: "tracker", payload: { kind: "query", action: { action: "appInfo" } } },
      origin: "null",
      source: iframe.contentWindow,
    });
    Object.defineProperty(event, "ports", { value: [{ postMessage, close: vi.fn() }] });
    window.dispatchEvent(event);

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      ok: true,
      value: { result: { id: "tracker" }, revision: "2" },
    }));
    expect(requests.at(-1)).toHaveBeenCalledOnce();
  });

  it("injects the active owner's participant identity into the app bridge", async () => {
    mocks.ownerShareGet.mockResolvedValue(ownerShare());
    mocks.createApi.mockReturnValue({
      get: vi.fn(),
      direct: { request: vi.fn(), subscribeEvents: vi.fn().mockReturnValue(() => undefined), close: vi.fn() },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html><head></head><body></body></html>")));

    render(<AppViewer path="matrix-app:tracker" />);
    const iframe = screen.getByTitle("matrix-app:tracker") as HTMLIFrameElement;
    await waitFor(() => expect(iframe.srcdoc).toContain('"actorId":"user_owner"'));
    expect(iframe.srcdoc).toContain('"scopeId":"10000000-0000-4000-8000-000000000001"');
    expect(iframe.srcdoc).toContain('"shareRevision":"1"');
    expect(iframe.srcdoc).toContain('"buildId":"' + "b".repeat(64) + '"');
  });

  it("updates the owner bridge context without replacing an unfinished iframe", async () => {
    mocks.organization.mockReturnValue({ status: "member", organizationId: target.organizationId, organizationName: "Matrix" });
    mocks.ownerShareGet.mockResolvedValueOnce(null).mockResolvedValue(ownerShare());
    mocks.createApi.mockReturnValue({
      get: vi.fn(),
      direct: { request: vi.fn(), subscribeEvents: vi.fn().mockReturnValue(() => undefined), close: vi.fn() },
    });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("<html><head></head><body></body></html>")));

    render(<AppViewer path="matrix-app:tracker" />);
    await waitFor(() => expect(mocks.shareButton).toHaveBeenCalled());
    const iframe = screen.getByTitle("matrix-app:tracker") as HTMLIFrameElement;
    await waitFor(() => expect(iframe.srcdoc).toContain("collaboration:"));
    const originalHtml = iframe.srcdoc;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    await act(async () => {
      await (mocks.shareButton.mock.lastCall![0] as { onShareChanged(): Promise<void> }).onShareChanged();
    });

    expect(screen.getByTitle("matrix-app:tracker")).toBe(iframe);
    expect(iframe.srcdoc).toBe(originalHtml);
    expect(postMessage).toHaveBeenCalledWith({
      type: "os:collaboration-context",
      participant: expect.objectContaining({ scopeId: target.scopeId, shareRevision: "1" }),
    }, "*");
  });
});
