// @vitest-environment jsdom

import React, { useMemo, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmbedHost from "../../desktop/src/renderer/src/features/embeds/EmbedHost";
import { invoke, onEvent } from "../../desktop/src/renderer/src/lib/operator";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";
import { SurfaceChromeContext, type SurfaceChromeSpec } from "../../desktop/src/renderer/src/features/desktop-shell/SurfaceChrome";

const publishing = vi.hoisted(() => ({ client: { get: vi.fn(async () => null), getConfig: vi.fn(async () => ({ data: {}, forms: [] })), deploy: vi.fn() } }));
const SHARED_TARGET = {
  scopeId: "10000000-0000-4000-8000-000000000001",
  runtimeId: "runtime_owner",
  organizationId: "org_matrix",
  authorityGeneration: 2,
  appId: "team-tracker",
  catalogId: "30000000-0000-4000-8000-000000000001",
  readinessId: "40000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64),
  buildId: "b".repeat(64),
  shareRevision: "7",
  owner: { actorId: "user_owner", displayName: "Nima" },
};
vi.mock("../../desktop/src/renderer/src/features/app-sites/site-client", () => ({ createDesktopSiteClient: () => publishing.client }));

vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({
  invoke: vi.fn(),
  onEvent: vi.fn(() => () => undefined),
}));

/** Organization sharing is one compact row in the Publish app popover; its controls open in place. */
async function openOrganizationSharing() {
  fireEvent.click(await screen.findByRole("button", { name: /^Share(d)? with/ }));
  await screen.findByRole("heading", { name: "Organization sharing" });
}

function EmbedHostWithChrome(props: React.ComponentProps<typeof EmbedHost>) {
  const [chrome, setChrome] = useState<SurfaceChromeSpec | null>(null);
  const host = useMemo(() => ({ setChrome }), []);
  return <SurfaceChromeContext.Provider value={host}>
    <div data-testid="embed-toolbar">{chrome?.rightActions}</div>
    <EmbedHost {...props} />
  </SurfaceChromeContext.Provider>;
}

describe("EmbedHost", () => {
  let openResolve: ((value: { embedId: string; state: "loading" | "auth-required" }) => void) | null = null;
  let rect = { left: 10, top: 20, width: 300, height: 200 };

  beforeEach(() => {
    publishing.client.getConfig.mockClear();
    publishing.client.deploy.mockClear();
    vi.mocked(invoke).mockClear();
    vi.mocked(onEvent).mockReset();
    vi.mocked(onEvent).mockReturnValue(() => undefined);
    useConnection.setState(useConnection.getInitialState(), true);
    useUi.setState(useUi.getInitialState(), true);
    useConnection.setState({ runtimeSlot: "primary" });
    openResolve = null;
    rect = { left: 10, top: 20, width: 300, height: 200 };
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        return new Promise((resolve) => {
          openResolve = resolve as typeof openResolve;
        }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          x: rect.left,
          y: rect.top,
          left: rect.left,
          top: rect.top,
          right: rect.left + rect.width,
          bottom: rect.top + rect.height,
          width: rect.width,
          height: rect.height,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("checks, shares, and stops organization access inside the single Publish app popover", async () => {
    const build = {
      appId: "notes", catalogId: "30000000-0000-4000-8000-000000000001",
      registrationIncarnation: "a".repeat(64), manifestVersion: "1.0.0", buildId: "b".repeat(64),
      manifestDigest: "c".repeat(64), schemaDigest: "d".repeat(64), assetDigest: "e".repeat(64),
      bridgeContractVersion: "matrix-app-bridge-v1", runtimeAbi: "matrix-runtime-v1",
    };
    const readiness = {
      readinessId: "40000000-0000-4000-8000-000000000001", build, status: "ready", revision: "2",
      checks: [{ code: "cleanup", status: "passed" }], verifiedAt: "2026-11-11T18:00:00.000Z",
    };
    const activeShare = {
      scopeId: "10000000-0000-4000-8000-000000000001", organizationId: "org_matrix",
      owner: { actorId: "user_owner", displayName: "Owner" }, build, readinessId: readiness.readinessId,
      state: "active", shareRevision: "3", bindingRevision: "4", dataRevision: "5",
      createdAt: "2026-11-11T18:00:00.000Z", updatedAt: "2026-11-11T18:00:00.000Z",
    };
    let share: typeof activeShare | null = null;
    let readinessReady = false;
    const gateway = {
      get: vi.fn(async (path: string) => path.endsWith("/readiness")
        ? readinessReady ? readiness : null
        : path.endsWith("/registration") ? { registrationIncarnation: build.registrationIncarnation } : share),
      post: vi.fn(async (path: string) => {
        if (path.endsWith("/readiness/check")) { readinessReady = true; return readiness; }
        if (path.endsWith("/share/preflight")) return {
          eligible: true, catalogId: build.catalogId, resourceRevision: "1", readinessId: readiness.readinessId,
          buildId: build.buildId, confirmationToken: "a".repeat(32),
        };
        share = activeShare;
        return share;
      }),
      delete: vi.fn(async () => { share = { ...activeShare, state: "stopped" }; return share; }),
    };
    useConnection.setState({ organizationId: "org_matrix", organizationStatus: "member",
      api: { forRuntime: () => gateway } as unknown as NonNullable<ReturnType<typeof useConnection.getState>["api"]> });
    render(<EmbedHostWithChrome kind="app" slug="notes" active />);

    expect(screen.getAllByRole("button", { name: "Publish app" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Share app" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Publish app" }));
    const dialog = await screen.findByRole("dialog", { name: "Share app" });
    expect(screen.getByTestId("created-app-surface").contains(dialog)).toBe(true);
    await openOrganizationSharing();
    const region = screen.getByRole("region", { name: "Share with your org" });
    expect(screen.getByText(/including guests/)).toBeTruthy();
    expect(screen.getByText(/stay on your Matrix/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Check collaboration" }));
    fireEvent.click(await screen.findByRole("button", { name: "Share with your org" }));
    await waitFor(() => expect(gateway.post).toHaveBeenCalledWith("/api/collaboration/apps/notes/share", expect.objectContaining({ organizationId: "org_matrix" })));
    expect(within(region).getByText(/^Shared with/)).toBeTruthy();
    expect(publishing.client.getConfig).not.toHaveBeenCalled();
    expect(publishing.client.deploy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    await waitFor(() => expect(gateway.delete).toHaveBeenCalledWith("/api/collaboration/apps/notes/share", expect.objectContaining({ expectedBindingRevision: "4" })));
  });

  it("shows no organization and keeps collaboration actions disabled", async () => {
    useConnection.setState({ organizationStatus: "none", api: { forRuntime: () => ({ get: vi.fn(), post: vi.fn() }) } as unknown as NonNullable<ReturnType<typeof useConnection.getState>["api"]> });
    render(<EmbedHostWithChrome kind="app" slug="notes" active />);
    fireEvent.click(screen.getByRole("button", { name: "Publish app" }));
    await openOrganizationSharing();
    expect(await screen.findByText(/Select an organization/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share with your org" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check collaboration" })).toBeNull();
  });

  it("shows blocked readiness and a safe request error without enabling sharing", async () => {
    const build = {
      appId: "notes", catalogId: "30000000-0000-4000-8000-000000000001",
      registrationIncarnation: "a".repeat(64), manifestVersion: "1.0.0", buildId: "b".repeat(64),
      manifestDigest: "c".repeat(64), schemaDigest: "d".repeat(64), assetDigest: "e".repeat(64),
      bridgeContractVersion: "matrix-app-bridge-v1", runtimeAbi: "matrix-runtime-v1",
    };
    const gateway = {
      get: vi.fn(async (path: string) => path.endsWith("/readiness") ? {
        readinessId: "40000000-0000-4000-8000-000000000001", build,
        status: "blocked", revision: "2", checks: [{ code: "declaration", status: "blocked", action: "Declare collaborative capability." }],
      } : null),
      post: vi.fn(async () => { throw new Error("postgres password=private"); }),
      delete: vi.fn(),
    };
    useConnection.setState({ organizationId: "org_matrix", organizationStatus: "member",
      api: { forRuntime: () => gateway } as unknown as NonNullable<ReturnType<typeof useConnection.getState>["api"]> });
    render(<EmbedHostWithChrome kind="app" slug="notes" active />);
    fireEvent.click(screen.getByRole("button", { name: "Publish app" }));
    await openOrganizationSharing();
    expect(await screen.findByText("Declare collaborative capability.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Share with your org" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check collaboration" }));
    expect(await screen.findByText("App collaboration readiness is unavailable.")).toBeTruthy();
    expect(screen.queryByText(/postgres password/)).toBeNull();
    expect(gateway.post).toHaveBeenCalledWith("/api/collaboration/apps/notes/readiness/check", expect.objectContaining({ organizationId: "org_matrix" }));
  });

  it("retries a failed initial share read when checking collaboration", async () => {
    const build = {
      appId: "notes", catalogId: "30000000-0000-4000-8000-000000000001",
      registrationIncarnation: "a".repeat(64), manifestVersion: "1.0.0", buildId: "b".repeat(64),
      manifestDigest: "c".repeat(64), schemaDigest: "d".repeat(64), assetDigest: "e".repeat(64),
      bridgeContractVersion: "matrix-app-bridge-v1", runtimeAbi: "matrix-runtime-v1",
    };
    const readiness = {
      readinessId: "40000000-0000-4000-8000-000000000001", build, status: "ready", revision: "2",
      checks: [{ code: "cleanup", status: "passed" }], verifiedAt: "2026-11-11T18:00:00.000Z",
    };
    let shareReads = 0;
    const gateway = {
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/share")) {
          if (++shareReads === 1) throw new Error("database password=private");
          return null;
        }
        if (path.endsWith("/registration")) return { registrationIncarnation: build.registrationIncarnation };
        return readiness;
      }),
      post: vi.fn(async () => readiness),
      delete: vi.fn(),
    };
    useConnection.setState({ organizationId: "org_matrix", organizationStatus: "member",
      api: { forRuntime: () => gateway } as unknown as NonNullable<ReturnType<typeof useConnection.getState>["api"]> });
    render(<EmbedHostWithChrome kind="app" slug="notes" active />);
    fireEvent.click(screen.getByRole("button", { name: "Publish app" }));
    await openOrganizationSharing();
    expect(await screen.findByText("App sharing is unavailable. Try again.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Share with your org" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check collaboration" }));
    await waitFor(() => expect(shareReads).toBe(2));
    await waitFor(() => expect((screen.getByRole("button", { name: "Share with your org" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/database password/)).toBeNull();
  });

  it("shows the corrective action from a failed readiness result", async () => {
    const build = {
      appId: "notes", catalogId: "30000000-0000-4000-8000-000000000001",
      registrationIncarnation: "a".repeat(64), manifestVersion: "1.0.0", buildId: "b".repeat(64),
      manifestDigest: "c".repeat(64), schemaDigest: "d".repeat(64), assetDigest: "e".repeat(64),
      bridgeContractVersion: "matrix-app-bridge-v1", runtimeAbi: "matrix-runtime-v1",
    };
    const gateway = {
      get: vi.fn(async (path: string) => path.endsWith("/readiness") ? {
        readinessId: "40000000-0000-4000-8000-000000000001", build,
        status: "failed", revision: "2", checks: [{ code: "provider_safety", status: "failed", action: "Review the provider policy." }],
      } : null),
      post: vi.fn(),
      delete: vi.fn(),
    };
    useConnection.setState({ organizationId: "org_matrix", organizationStatus: "member",
      api: { forRuntime: () => gateway } as unknown as NonNullable<ReturnType<typeof useConnection.getState>["api"]> });
    render(<EmbedHostWithChrome kind="app" slug="notes" active />);
    fireEvent.click(screen.getByRole("button", { name: "Publish app" }));
    await openOrganizationSharing();
    expect(await screen.findByText("Review the provider policy.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Share with your org" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes a retained hidden app's publishing portal and releases only its own renderer overlay", async () => {
    useConnection.setState({ api: { forRuntime: () => ({ get: vi.fn(async () => null) }) } as unknown as NonNullable<ReturnType<typeof useConnection.getState>["api"]> });
    useUi.getState().acquireRendererOverlay(); // A separate surface owns this lease.
    const view = render(<EmbedHostWithChrome kind="app" slug="notes" active />);
    expect(screen.queryByTestId("app-publishing-bar")).toBeNull();
    expect(screen.getByTestId("embed-toolbar").contains(screen.getByRole("button", { name: "Publish app" }))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Publish app" }));
    const dialog = await screen.findByRole("dialog", { name: "Share app" });
    expect(screen.getByTestId("created-app-surface").contains(dialog)).toBe(true);
    expect(useUi.getState().rendererOverlayCount).toBe(2);
    // Overlay-adjusted native activity is false, but the owning surface is still visible.
    expect(screen.getByRole("dialog", { name: "Share app" })).toBeTruthy();

    view.rerender(<EmbedHostWithChrome kind="app" slug="notes" active={false} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useUi.getState().rendererOverlayCount).toBe(1);
    view.rerender(<EmbedHostWithChrome kind="app" slug="notes" active />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Publish app" }));
    await screen.findByRole("dialog", { name: "Share app" });
    expect(useUi.getState().rendererOverlayCount).toBe(2);
    view.unmount();
    expect(useUi.getState().rendererOverlayCount).toBe(1);
    useUi.getState().releaseRendererOverlay();
    expect(useUi.getState().rendererOverlayCount).toBe(0);
  });

  it("sends the actual window radius at canvas scale and clears clipping in tab mode", async () => {
    const view = render(<section data-os-window data-surface-mode="window" style={{ borderBottomLeftRadius: "12px" }}>
      <EmbedHost kind="app" slug="notes" layoutRevision="window" visualScale={0.5} />
    </section>);
    expect(invoke).toHaveBeenCalledWith("embed:open", expect.objectContaining({ bounds: { x: 10, y: 20, width: 300, height: 200, cornerRadius: 6 } }));
    await act(async () => { openResolve?.({ embedId: "app-1", state: "loading" }); });
    expect(invoke).toHaveBeenCalledWith("embed:set-bounds", { embedId: "app-1", bounds: { x: 10, y: 20, width: 300, height: 200, cornerRadius: 6 } });
    view.rerender(<section data-os-window data-surface-mode="tab" style={{ borderBottomLeftRadius: "0px" }}>
      <EmbedHost kind="app" slug="notes" layoutRevision="tab" visualScale={1} />
    </section>);
    expect(invoke).toHaveBeenLastCalledWith("embed:set-bounds", { embedId: "app-1", bounds: { x: 10, y: 20, width: 300, height: 200 } });
  });

  it("reports fresh bounds when the embed opens after a pending layout change", async () => {
    render(<EmbedHost kind="hosted-shell" />);

    rect = { left: 40, top: 50, width: 640, height: 480 };
    window.dispatchEvent(new Event("resize"));

    await act(async () => {
      openResolve?.({ embedId: "embed-1", state: "loading" });
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:set-bounds", {
        embedId: "embed-1",
        bounds: { x: 40, y: 50, width: 640, height: 480 },
      });
    });
  });

  it("reports position-only changes when its desktop layout revision changes", async () => {
    const view = render(<EmbedHost kind="hosted-shell" layoutRevision="window:10:20:300:200" />);
    await act(async () => {
      openResolve?.({ embedId: "embed-1", state: "loading" });
    });
    vi.mocked(invoke).mockClear();
    rect = { left: 90, top: 120, width: 300, height: 200 };

    view.rerender(<EmbedHost kind="hosted-shell" layoutRevision="window:90:120:300:200" />);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:set-bounds", {
        embedId: "embed-1",
        bounds: { x: 90, y: 120, width: 300, height: 200 },
      });
    });
  });

  it("keeps a retained native frame visible after an embed moves behind another window", async () => {
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        return Promise.resolve({ embedId: "browser-1", state: "ready" }) as ReturnType<typeof invoke>;
      }
      if (channel === "embed:deactivate") {
        return Promise.resolve({
          ok: true,
          snapshotDataUrl: "data:image/jpeg;base64,cGVyc2lzdGVkLWJyb3dzZXI=",
        }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    const view = render(<EmbedHost kind="browser" url="https://example.com" active />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "embed:set-active",
      { embedId: "browser-1", active: true },
    ));

    view.rerender(<EmbedHost kind="browser" url="https://example.com" active={false} />);

    const retainedFrame = await screen.findByTestId("embed-retained-frame");
    expect(retainedFrame.getAttribute("src")).toBe("data:image/jpeg;base64,cGVyc2lzdGVkLWJyb3dzZXI=");
    expect(invoke).toHaveBeenCalledWith("embed:deactivate", { embedId: "browser-1" });
  });

  it("clears a retained frame when an inactive embed is replaced", async () => {
    let nextEmbedId = 0;
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        nextEmbedId += 1;
        return Promise.resolve({ embedId: `browser-${nextEmbedId}`, state: "ready" }) as ReturnType<typeof invoke>;
      }
      if (channel === "embed:deactivate") {
        return Promise.resolve({
          ok: true,
          snapshotDataUrl: "data:image/jpeg;base64,b2xkLXBhZ2U=",
        }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    const view = render(<EmbedHost kind="browser" url="https://one.example" active />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "embed:set-active",
      { embedId: "browser-1", active: true },
    ));
    view.rerender(<EmbedHost kind="browser" url="https://one.example" active={false} />);
    expect(await screen.findByTestId("embed-retained-frame")).toBeTruthy();

    view.rerender(<EmbedHost kind="browser" url="https://two.example" active={false} />);

    expect(screen.queryByTestId("embed-retained-frame")).toBeNull();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "embed:open",
      expect.objectContaining({ kind: "browser", url: "https://two.example", active: false }),
    ));
  });

  it.each([
    ["Home", (active: boolean) => <EmbedHost kind="hosted-shell" active={active} />],
    ["VS Code", (active: boolean) => <EmbedHost kind="code-editor" active={active} />],
    ["installed web apps", (active: boolean) => (
      <EmbedHost kind="app" slug="whiteboard" active={active} />
    )],
  ])("uses the same retained-frame lifecycle for %s", async (_label, renderEmbed) => {
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        return Promise.resolve({ embedId: "embed-1", state: "ready" }) as ReturnType<typeof invoke>;
      }
      if (channel === "embed:deactivate") {
        return Promise.resolve({
          ok: true,
          snapshotDataUrl: "data:image/jpeg;base64,cmV0YWluZWQ=",
        }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });
    const view = render(renderEmbed(true));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "embed:set-active",
      { embedId: "embed-1", active: true },
    ));

    view.rerender(renderEmbed(false));

    expect(await screen.findByTestId("embed-retained-frame")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("embed:deactivate", { embedId: "embed-1" });
  });

  it("resynchronizes native bounds and page scale when the Canvas transform changes", async () => {
    const view = render(<EmbedHost kind="app" slug="notes" layoutRevision="canvas:0:0:1" visualScale={1} />);
    await act(async () => {
      openResolve?.({ embedId: "embed-1", state: "loading" });
    });
    vi.mocked(invoke).mockClear();
    rect = { left: -180, top: 75, width: 450, height: 300 };

    view.rerender(<EmbedHost kind="app" slug="notes" layoutRevision="canvas:-200:50:0.5" visualScale={0.5} />);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:set-scale", { embedId: "embed-1", factor: 0.5 });
      expect(invoke).toHaveBeenCalledWith("embed:set-bounds", {
        embedId: "embed-1",
        bounds: { x: -180, y: 75, width: 450, height: 300 },
      });
    });
  });

  it("restores the auth retry prompt when retryAuth returns ok false", async () => {
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        return Promise.resolve({ embedId: "embed-1", state: "auth-required" }) as ReturnType<typeof invoke>;
      }
      if (channel === "embed:retry-auth") {
        return Promise.resolve({ ok: false }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    render(<EmbedHost kind="hosted-shell" />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry sign-in" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:retry-auth", { embedId: "embed-1" });
      expect(screen.getByRole("button", { name: "Retry sign-in" })).toBeTruthy();
    });
  });

  it("preserves an app failure reported during an auth retry", async () => {
    let emitState: ((payload: { embedId: string; state: "failed" }) => void) | null = null;
    vi.mocked(onEvent).mockImplementation((_channel, callback) => {
      emitState = callback as typeof emitState;
      return () => undefined;
    });
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        return Promise.resolve({ embedId: "embed-1", state: "auth-required" }) as ReturnType<typeof invoke>;
      }
      if (channel === "embed:retry-auth") {
        emitState?.({ embedId: "embed-1", state: "failed" });
        return Promise.resolve({ ok: false }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });
    render(<EmbedHost kind="app" slug="spec-reader" />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry sign-in" }));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry sign-in" })).toBeNull();
  });

  it("detaches a retained shared app while its retry overlay is visible and reloads it exactly once", async () => {
    let emitState: ((payload: { embedId: string; state: "host-offline" }) => void) | null = null;
    vi.mocked(onEvent).mockImplementation((_channel, callback) => {
      emitState = callback as typeof emitState;
      return () => undefined;
    });
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        return Promise.resolve({ embedId: "shared-1", state: "loading" }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    render(<EmbedHost kind="shared-app" target={SHARED_TARGET} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "embed:set-active",
      { embedId: "shared-1", active: true },
    ));

    act(() => emitState?.({ embedId: "shared-1", state: "host-offline" }));

    await screen.findByText("The owner’s computer is offline. This app is still open.");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "embed:set-active",
      { embedId: "shared-1", active: false },
    ));
    vi.mocked(invoke).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      const calls = vi.mocked(invoke).mock.calls;
      expect(calls).toContainEqual(["embed:reload", { embedId: "shared-1" }]);
      expect(calls.filter(([channel]) => channel === "embed:reload")).toHaveLength(1);
      expect(calls).not.toContainEqual(["embed:set-active", { embedId: "shared-1", active: true }]);
    });
  });

  it("refreshes bounds after a successful auth retry", async () => {
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        return Promise.resolve({ embedId: "embed-1", state: "auth-required" }) as ReturnType<typeof invoke>;
      }
      if (channel === "embed:retry-auth") {
        return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    render(<EmbedHost kind="hosted-shell" />);

    await screen.findByRole("button", { name: "Retry sign-in" });
    vi.mocked(invoke).mockClear();
    rect = { left: 90, top: 100, width: 700, height: 500 };
    fireEvent.click(screen.getByRole("button", { name: "Retry sign-in" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:retry-auth", { embedId: "embed-1" });
      expect(invoke).toHaveBeenCalledWith("embed:set-bounds", {
        embedId: "embed-1",
        bounds: { x: 90, y: 100, width: 700, height: 500 },
      });
    });
  });

  it("reopens the hosted surface after the trusted runtime changes", async () => {
    let nextEmbedId = 0;
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        nextEmbedId += 1;
        return Promise.resolve({ embedId: `embed-${nextEmbedId}`, state: "ready" }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    render(<EmbedHost kind="hosted-shell" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "embed:set-active",
      { embedId: "embed-1", active: true },
    ));

    act(() => {
      useConnection.setState({ runtimeSlot: "review" });
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:close", { embedId: "embed-1" });
      expect(invoke).toHaveBeenCalledWith(
        "embed:set-active",
        { embedId: "embed-2", active: true },
      );
    });
  });

  it("wires runtime Browser URLs through the typed embed request", async () => {
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        return Promise.resolve({ embedId: "browser-1", state: "loading" }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    render(<EmbedHost kind="browser" url="http://127.0.0.1:3000/docs" />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("embed:open", {
      kind: "browser",
      url: "http://127.0.0.1:3000/docs",
      bounds: { x: 10, y: 20, width: 300, height: 200 },
      active: true,
    }));
  });

  it("opens VS Code through the fixed trusted code-editor request", async () => {
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        return Promise.resolve({ embedId: "code-1", state: "loading" }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    render(<EmbedHost kind="code-editor" />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("embed:open", {
      kind: "code-editor",
      bounds: { x: 10, y: 20, width: 300, height: 200 },
      active: true,
    }));
  });

  it("retries an offline shared app in the retained native view", async () => {
    let emitState: ((payload: { embedId: string; state: "host-offline" }) => void) | null = null;
    vi.mocked(onEvent).mockImplementation((_channel, callback) => {
      emitState = callback as typeof emitState;
      return () => undefined;
    });
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        return Promise.resolve({ embedId: "shared-1", state: "ready" }) as ReturnType<typeof invoke>;
      }
      if (channel === "embed:reload") return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    render(<EmbedHost kind="shared-app" target={SHARED_TARGET} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("embed:open", {
      kind: "shared-app",
      target: SHARED_TARGET,
      bounds: { x: 10, y: 20, width: 300, height: 200 },
      active: true,
    }));

    act(() => emitState?.({ embedId: "shared-1", state: "host-offline" }));
    vi.mocked(invoke).mockClear();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("embed:reload", { embedId: "shared-1" }));
    expect(invoke).not.toHaveBeenCalledWith("embed:close", expect.anything());
  });

  it("reopens the same runtime Browser URL after an unexpected tunnel failure", async () => {
    let nextEmbedId = 0;
    let emitState: ((payload: { embedId: string; state: "failed" }) => void) | null = null;
    vi.mocked(onEvent).mockImplementation((_channel, callback) => {
      emitState = callback as typeof emitState;
      return () => undefined;
    });
    vi.mocked(invoke).mockImplementation((channel: string) => {
      if (channel === "embed:open") {
        nextEmbedId += 1;
        return Promise.resolve({ embedId: `browser-${nextEmbedId}`, state: "ready" }) as ReturnType<typeof invoke>;
      }
      return Promise.resolve({ ok: true }) as ReturnType<typeof invoke>;
    });

    render(<EmbedHost kind="browser" url="http://127.0.0.1:3000/docs" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "embed:set-active",
      { embedId: "browser-1", active: true },
    ));

    act(() => emitState?.({ embedId: "browser-1", state: "failed" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:close", { embedId: "browser-1" });
      expect(vi.mocked(invoke).mock.calls.filter(([channel]) => channel === "embed:open")).toHaveLength(2);
      expect(invoke).toHaveBeenCalledWith("embed:open", {
        kind: "browser",
        url: "http://127.0.0.1:3000/docs",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
        active: true,
      });
      expect(invoke).toHaveBeenCalledWith(
        "embed:set-active",
        { embedId: "browser-2", active: true },
      );
    });
  });

  it("reloads the retained native embed when the host receives a refresh request", async () => {
    const view = render(<EmbedHost kind="hosted-shell" refreshRequest={0} />);
    await act(async () => {
      openResolve?.({ embedId: "embed-1", state: "loading" });
    });
    vi.mocked(invoke).mockClear();

    view.rerender(<EmbedHost kind="hosted-shell" refreshRequest={1} />);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:reload", { embedId: "embed-1" });
    });
  });

  it("keeps a refresh request pending until the retained embed finishes opening", async () => {
    const view = render(<EmbedHost kind="hosted-shell" refreshRequest={0} />);
    view.rerender(<EmbedHost kind="hosted-shell" refreshRequest={1} />);
    expect(invoke).not.toHaveBeenCalledWith("embed:reload", expect.anything());

    await act(async () => {
      openResolve?.({ embedId: "embed-1", state: "loading" });
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:reload", { embedId: "embed-1" });
    });
  });

  it("keeps a refresh request pending while the retained embed is inactive", async () => {
    const view = render(<EmbedHost kind="hosted-shell" active={false} refreshRequest={0} />);
    await act(async () => {
      openResolve?.({ embedId: "embed-1", state: "loading" });
    });
    vi.mocked(invoke).mockClear();

    view.rerender(<EmbedHost kind="hosted-shell" active={false} refreshRequest={1} />);
    expect(invoke).not.toHaveBeenCalledWith("embed:reload", expect.anything());
    view.rerender(<EmbedHost kind="hosted-shell" active refreshRequest={1} />);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("embed:reload", { embedId: "embed-1" });
    });
  });
});
