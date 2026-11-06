import type { CollaborativeAppDirectoryItem } from "@matrix-os/contracts";
import { EmbedManager, type Bounds, type EmbedViewLike } from "@desktop/main/embeds/embed-manager";
import { EmbedService } from "@desktop/main/embeds/embed-service";
import { shouldAuthorizeSharedAppRequest } from "@desktop/main/embeds/web-contents-view";
import { INVOKE_CHANNELS } from "@desktop/shared/ipc-contract";
import { describe, expect, it, vi } from "vitest";

const BOUNDS: Bounds = { x: 12, y: 24, width: 960, height: 640 };
const DIGEST = "a".repeat(64);
const TARGET: CollaborativeAppDirectoryItem = {
  scopeId: "10000000-0000-4000-8000-000000000001",
  runtimeId: "runtime:owner",
  organizationId: "org_matrix",
  authorityGeneration: 3,
  appId: "inventory",
  catalogId: "10000000-0000-4000-8000-000000000003",
  readinessId: "10000000-0000-4000-8000-000000000004",
  registrationIncarnation: DIGEST,
  buildId: DIGEST,
  shareRevision: "7",
  owner: {
    actorId: "owner-1",
    displayName: "Owner One",
  },
};

describe("collaborative app Electron embed", () => {
  it("accepts only an exact shared target and never accepts credentials", () => {
    const schema = INVOKE_CHANNELS["embed:open"].request;

    expect(schema.safeParse({ kind: "shared-app", target: TARGET, bounds: BOUNDS }).success).toBe(true);
    expect(schema.safeParse({
      kind: "shared-app",
      target: { ...TARGET, buildId: "wrong" },
      bounds: BOUNDS,
    }).success).toBe(false);
    expect(schema.safeParse({
      kind: "shared-app",
      target: TARGET,
      bounds: BOUNDS,
      token: "owner-secret",
    }).success).toBe(false);
    expect(schema.safeParse({
      kind: "app",
      slug: TARGET.appId,
      target: TARGET,
      bounds: BOUNDS,
    }).success).toBe(false);
  });

  it("opens the exact shared shell route without using the owner app launch path", async () => {
    const service = new EmbedService({
      getWindow: () => null,
      getGatewayOrigin: () => "https://platform.test",
      getToken: () => "participant-token",
      emitState: vi.fn(),
    });
    const internals = service as unknown as {
      manager: { open: (...args: unknown[]) => string };
      fetchLaunchToken: (...args: unknown[]) => Promise<unknown>;
    };
    const open = vi.spyOn(internals.manager, "open").mockImplementation((...args) => (
      (args[4] as { id: string }).id
    ));
    const ownerLaunch = vi.spyOn(internals, "fetchLaunchToken");

    const result = await service.open({
      kind: "shared-app",
      target: TARGET,
      bounds: BOUNDS,
      active: true,
    } as never);

    expect(result.state).toBe("loading");
    expect(ownerLaunch).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      "shared-app",
      TARGET.scopeId,
      BOUNDS,
      `https://platform.test/shared/app/${TARGET.scopeId}?expectedBuildId=${TARGET.buildId}&expectedShareRevision=7`,
      expect.objectContaining({
        id: result.embedId,
        active: true,
        retainOnFailure: true,
        sharedAppTarget: TARGET,
      }),
    );

    await expect(service.open({ kind: "shared-app", bounds: BOUNDS } as never)).resolves.toMatchObject({ state: "failed" });
    expect(ownerLaunch).not.toHaveBeenCalled();
  });

  it("injects participant authentication only for the wrapper and exact shared-app transport", () => {
    const authorize = (requestUrl: string, method: string, mainFrame = false) => shouldAuthorizeSharedAppRequest({
      requestUrl,
      gatewayOrigin: "https://platform.test",
      scopeId: TARGET.scopeId,
      appId: TARGET.appId,
      method,
      mainFrame,
    });

    expect(authorize(`https://platform.test/shared/app/${TARGET.scopeId}`, "GET", true)).toBe(true);
    expect(authorize("https://platform.test/api/collaboration/shared-apps?limit=100", "GET")).toBe(true);
    expect(authorize("https://platform.test/api/collaboration/connections", "POST")).toBe(true);
    expect(authorize(
      `https://platform.test/api/collaboration/shared-apps/${TARGET.scopeId}/launch`,
      "POST",
    )).toBe(true);
    expect(authorize(
      `https://platform.test/api/collaboration/shared-apps/${TARGET.scopeId}/runtime/launch-1/index.js`,
      "GET",
    )).toBe(true);
    expect(authorize("https://platform.test/api/collaboration/direct-sessions", "POST")).toBe(true);
    expect(authorize(
      `https://platform.test/api/collaboration/scopes/${TARGET.scopeId}/apps/${TARGET.appId}/view`,
      "POST",
      true,
    )).toBe(true);
    expect(authorize(
      `https://platform.test/api/collaboration/scopes/${TARGET.scopeId}/apps/${TARGET.appId}/actions`,
      "POST",
      true,
    )).toBe(true);
    expect(authorize(
      `https://platform.test/api/collaboration/scopes/${TARGET.scopeId}/apps/${TARGET.appId}/actions`,
      "POST",
    )).toBe(false);
    expect(authorize("https://platform.test/api/collaboration/scopes/another/apps/inventory/actions", "POST")).toBe(false);
    expect(authorize(
      `https://platform.test/api/collaboration/scopes/${TARGET.scopeId}/apps/another/actions`,
      "POST",
      true,
    )).toBe(false);
    expect(authorize("https://platform.test/api/collaboration/shared-apps/20000000-0000-4000-8000-000000000002/launch", "POST")).toBe(false);
    expect(authorize("https://platform.test/api/apps/inventory/session-token", "POST", true)).toBe(false);
    expect(authorize(`https://evil.test/shared/app/${TARGET.scopeId}`, "GET", true)).toBe(false);
    expect(authorize("https://platform.test/api/collaboration/shared-apps", "POST")).toBe(false);
  });

  it("retains and reloads the same native view after an offline load failure", async () => {
    const events: string[] = [];
    let emitState: ((state: "loading" | "ready" | "failed") => void) | undefined;
    const view: EmbedViewLike = {
      setBounds: vi.fn(),
      setScale: vi.fn(),
      loadUrl: vi.fn(async () => { events.push("load"); }),
      attach: vi.fn(() => { events.push("attach"); }),
      detach: vi.fn(() => { events.push("detach"); }),
      destroy: vi.fn(() => { events.push("destroy"); }),
    };
    const manager = new EmbedManager({
      allowedOrigins: ["https://platform.test"],
      createView: (options) => {
        emitState = options.onState;
        return view;
      },
    });
    const embedId = manager.open(
      "shared-app",
      TARGET.scopeId,
      BOUNDS,
      `https://platform.test/shared/app/${TARGET.scopeId}`,
      { retainOnFailure: true },
    );

    emitState?.("failed");
    expect(events).not.toContain("detach");
    expect(manager.liveCount).toBe(1);

    expect(manager.reload(embedId)).toBe(true);
    expect(view.loadUrl).toHaveBeenCalledTimes(2);
    expect(view.destroy).not.toHaveBeenCalled();
  });
});
