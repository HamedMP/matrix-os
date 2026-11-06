// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  SharedAppViewer,
  createSharedAppTransport,
  type SharedAppTarget,
} from "../../packages/ui/src/collaboration/collaborative-app-sharing.js";
import { CollaborationDirectError } from "../../packages/ui/src/collaboration/direct-client.js";

const scopeId = "10000000-0000-4000-8000-000000000001";
const launchId = "20000000-0000-4000-8000-000000000001";
const target: SharedAppTarget = {
  scopeId,
  organizationId: "org_matrix_team",
  appId: "team-tracker",
  catalogId: "30000000-0000-4000-8000-000000000001",
  readinessId: "40000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64),
  buildId: "b".repeat(64),
  shareRevision: "2",
  authorityGeneration: 3,
  runtimeId: "vps:50000000-0000-4000-8000-000000000001",
  owner: { actorId: "user_owner", displayName: "Owner" },
};

function setup() {
  let eventHandlers: { onEvent(): void; onUnavailable(): void } | undefined;
  const platform = {
    get: vi.fn(),
    post: vi.fn(async () => ({
      target: { kind: "shared", scopeId, organizationId: target.organizationId, appId: target.appId,
        catalogId: target.catalogId, buildId: target.buildId, name: "Team tracker", owner: target.owner,
        shareRevision: target.shareRevision },
      launchId,
      entryUrl: `/api/collaboration/shared-apps/${scopeId}/runtime/${launchId}/index.html`,
      expiresAt: "2026-11-05T10:05:00.000Z",
    })),
  };
  const direct = {
    request: vi.fn(async (_scope: string, _method: string, path: string) => path.endsWith("/view")
      ? { result: { rows: ["one"] } }
      : { result: { saved: true }, revision: 3, replayed: false }),
    subscribeEvents: vi.fn((_scope: string, handlers: typeof eventHandlers) => {
      eventHandlers = handlers;
      return vi.fn();
    }),
    close: vi.fn(),
  };
  return { platform, direct, eventHandlers: () => eventHandlers };
}

describe("shared app transport", () => {
  it("launches the exact advertised build and retries an uncertain mutation with one request id", async () => {
    const { platform, direct } = setup();
    direct.request.mockRejectedValueOnce(new CollaborationDirectError("unavailable"));
    const transport = createSharedAppTransport({ platform, direct: direct as never, target });

    await expect(transport.launch()).resolves.toMatchObject({ launchId });
    await expect(transport.mutate({ type: "rename", value: "Kept locally" }, "2"))
      .rejects.toMatchObject({ code: "uncertain" });
    const retry = await transport.retryMutation();

    expect(retry).toMatchObject({ revision: "3", replayed: false });
    expect(platform.post).toHaveBeenCalledWith(`/api/collaboration/shared-apps/${scopeId}/launch`, {
      clientRequestId: expect.any(String), expectedShareRevision: "2", expectedBuildId: "b".repeat(64),
    });
    expect(direct.request).toHaveBeenCalledTimes(2);
    expect((direct.request.mock.calls[0]![3] as { clientRequestId: string }).clientRequestId)
      .toBe((direct.request.mock.calls[1]![3] as { clientRequestId: string }).clientRequestId);
  });

  it("maps conflict, host-offline, recheck and ended-access states without leaking raw errors", async () => {
    const cases = [
      [new CollaborationDirectError("invalid_request"), "conflict"],
      [new CollaborationDirectError("host_offline"), "host_offline"],
      [new CollaborationDirectError("denied"), "access_ended"],
    ] as const;
    for (const [failure, code] of cases) {
      const { platform, direct } = setup();
      direct.request.mockRejectedValueOnce(failure);
      const transport = createSharedAppTransport({ platform, direct: direct as never, target });
      await expect(transport.query({ type: "list" })).rejects.toMatchObject({ code });
    }
    const changed = { ...target, shareRevision: "3" };
    const { platform, direct } = setup();
    const transport = createSharedAppTransport({ platform, direct: direct as never, target: changed });
    platform.post.mockRejectedValueOnce(new Error("postgres password=secret"));
    await expect(transport.launch()).rejects.toMatchObject({ code: "unavailable", message: "Shared app is unavailable." });
  });
});

describe("SharedAppViewer", () => {
  it("keeps one iframe mounted while host-offline and conflict overlays preserve app-local input", async () => {
    const { platform, direct, eventHandlers } = setup();
    const transport = createSharedAppTransport({ platform, direct: direct as never, target });
    const view = render(<SharedAppViewer target={target} transport={transport} />);
    const frame = await screen.findByTitle("Team tracker shared by Owner");
    expect(frame).toHaveAttribute("src", expect.stringContaining(launchId));
    expect(direct.subscribeEvents).toHaveBeenCalledTimes(1);

    await act(async () => { eventHandlers()?.onUnavailable(); });
    expect(screen.getByRole("alert")).toHaveTextContent("owner’s computer is offline");
    expect(screen.getByTitle("Team tracker shared by Owner")).toBe(frame);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(platform.post).toHaveBeenCalledTimes(2));
    expect(screen.getByTitle("Team tracker shared by Owner")).toBe(frame);

    window.dispatchEvent(new MessageEvent("message", {
      source: (frame as HTMLIFrameElement).contentWindow,
      // Sandboxed shared apps intentionally have an opaque origin. Exact source
      // matching keeps this restricted bridge bound to the mounted iframe.
      origin: "null",
      data: { type: "matrix:shared-app:mutate", requestId: "req_12345678", expectedRevision: "1", action: { value: "draft" } },
    }));
    await waitFor(() => expect(direct.request).toHaveBeenCalledWith(scopeId, "POST",
      `/api/collaboration/scopes/${scopeId}/apps/team-tracker/actions`, expect.objectContaining({ action: { value: "draft" } })));
    view.unmount();
  });

  it("uses a supported app-info refresh and notifies the exact opaque iframe with a wildcard target", async () => {
    const { platform, direct, eventHandlers } = setup();
    const transport = createSharedAppTransport({ platform, direct: direct as never, target });
    render(<SharedAppViewer target={target} transport={transport} />);
    const frame = await screen.findByTitle("Team tracker shared by Owner") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    await act(async () => { await eventHandlers()?.onEvent(); });

    expect(direct.request).toHaveBeenCalledWith(scopeId, "POST",
      `/api/collaboration/scopes/${scopeId}/apps/team-tracker/view`,
      { action: { action: "appInfo", app: "team-tracker" } });
    expect(postMessage).toHaveBeenCalledWith({ type: "matrix:shared-app:changed" }, "*");
  });

  it("retries an uncertain iframe mutation through retryMutation instead of relaunching", async () => {
    const { platform, direct } = setup();
    direct.request.mockRejectedValueOnce(new CollaborationDirectError("unavailable"));
    const transport = createSharedAppTransport({ platform, direct: direct as never, target });
    render(<SharedAppViewer target={target} transport={transport} />);
    const frame = await screen.findByTitle("Team tracker shared by Owner") as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: { type: "matrix:shared-app:mutate", requestId: "req_12345678", expectedRevision: "1", action: { value: "draft" } },
    }));
    await screen.findByText("Change not confirmed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(direct.request).toHaveBeenCalledTimes(2));

    expect(platform.post).toHaveBeenCalledTimes(1);
    expect((direct.request.mock.calls[0]![3] as { clientRequestId: string }).clientRequestId)
      .toBe((direct.request.mock.calls[1]![3] as { clientRequestId: string }).clientRequestId);
  });

  it("withdraws the old iframe immediately when the scope or exact build changes", async () => {
    const first = setup();
    const firstTransport = createSharedAppTransport({ platform: first.platform, direct: first.direct as never, target });
    const view = render(<SharedAppViewer target={target} transport={firstTransport} />);
    const oldFrame = await screen.findByTitle("Team tracker shared by Owner");
    expect(oldFrame).toHaveAttribute("src", expect.stringContaining(launchId));
    const nextTarget = { ...target, scopeId: "10000000-0000-4000-8000-000000000009", buildId: "c".repeat(64) };
    const second = setup();
    second.platform.post.mockResolvedValueOnce({
      target: { kind: "shared", scopeId: nextTarget.scopeId, organizationId: nextTarget.organizationId,
        appId: nextTarget.appId, catalogId: nextTarget.catalogId, buildId: nextTarget.buildId,
        name: "Team tracker", owner: nextTarget.owner, shareRevision: nextTarget.shareRevision },
      launchId: "20000000-0000-4000-8000-000000000009",
      entryUrl: "/new-build/index.html",
      expiresAt: "2026-11-05T10:05:00.000Z",
    });
    const secondTransport = createSharedAppTransport({ platform: second.platform, direct: second.direct as never, target: nextTarget });

    view.rerender(<SharedAppViewer target={nextTarget} transport={secondTransport} />);

    expect(screen.queryByTitle("Team tracker shared by Owner")).toBeNull();
    expect(await screen.findByTitle("Team tracker shared by Owner")).toHaveAttribute("src", "/new-build/index.html");
  });

  it("ends access in place and never remounts or retries the iframe", async () => {
    const { platform, direct, eventHandlers } = setup();
    const transport = createSharedAppTransport({ platform, direct: direct as never, target });
    render(<SharedAppViewer target={target} transport={transport} />);
    const frame = await screen.findByTitle("Team tracker shared by Owner");
    await act(async () => { eventHandlers()?.onUnavailable(); });
    direct.request.mockRejectedValueOnce(new CollaborationDirectError("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Access to this shared app has ended"));
    expect(screen.getByTitle("Team tracker shared by Owner")).toBe(frame);
  });
});
