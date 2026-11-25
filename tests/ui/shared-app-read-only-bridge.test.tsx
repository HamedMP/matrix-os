// @vitest-environment jsdom
import { runInNewContext } from "node:vm";
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { APP_BRIDGE_STORED_VALUE_PREFIX } from "@matrix-os/contracts";
import { collaborativeAppBridgeBootstrap } from "../../packages/platform/src/collaboration/app-bridge-bootstrap";
import { SharedAppViewer } from "../../packages/ui/src/collaboration/SharedAppViewer";
import { createSharedAppTransport, type SharedAppTarget } from "../../packages/ui/src/collaboration/shared-app-transport";
import { CollaborationDirectError } from "../../packages/ui/src/collaboration/direct-client";

// Outcome (ENG-579): a teammate opens an app that isn't collaborative and sees the owner's data
// through the app's ordinary `db.*` and `readData` calls; edits are refused without ending access.
// Faults detected: a read-only share rendering empty (no db/readData), writes reaching the owner,
// stored values arriving still wrapped, and a refused write showing "Access ended".

const scopeId = "10000000-0000-4000-8000-000000000002";
const target: SharedAppTarget = {
  scopeId, organizationId: "org_matrix", appId: "notes", catalogId: "30000000-0000-4000-8000-000000000002",
  readinessId: "40000000-0000-4000-8000-000000000002", registrationIncarnation: "a".repeat(64), buildId: "b".repeat(64),
  shareRevision: "2", authorityGeneration: 1, runtimeId: "runtime_owner", owner: { actorId: "user_owner", displayName: "Owner" },
};
const base = `/api/collaboration/scopes/${scopeId}/apps/notes`;
const rows = [{ id: "note-1", title: "Plan" }];
interface ReadOnlyBridge {
  db?: {
    find(table: string, options?: unknown): Promise<unknown>;
    findOne(table: string, id: string): Promise<unknown>;
    count(table: string): Promise<unknown>;
    insert(table: string, data: unknown): Promise<unknown>;
  };
  readData?(key: string): Promise<unknown>;
  writeData?(key: string, value: unknown): Promise<unknown>;
  collaboration: { mutate(action: unknown, revision: string): Promise<unknown>; retryMutation(): Promise<unknown> };
}
const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); cleanup(); vi.restoreAllMocks(); });

async function setup(readOnly: boolean) {
  const platform = { get: vi.fn(), post: vi.fn(async () => ({
    target: { kind: "shared", scopeId, organizationId: target.organizationId, appId: target.appId,
      catalogId: target.catalogId, buildId: target.buildId, name: "Notes", owner: target.owner, shareRevision: target.shareRevision },
    launchId: "20000000-0000-4000-8000-000000000002", entryUrl: "/shared-fixture/index.html", expiresAt: "2026-11-25T12:00:00.000Z",
  })) };
  const direct = {
    request: vi.fn(async (_scope: string, method: string, path: string, body?: { action?: { action?: string } }) => {
      if (method === "GET" && path === `${base}/data?key=clock.zones`) return { value: null };
      if (method === "GET" && path === `${base}/data?key=settings`) {
        return { value: `${APP_BRIDGE_STORED_VALUE_PREFIX}${JSON.stringify({ value: { theme: "dark" } })}` };
      }
      if (method === "POST" && path === `${base}/view`) {
        const action = body?.action?.action;
        return { result: action === "count" ? 1 : action === "findOne" ? rows[0] : rows, revision: "0" };
      }
      throw new Error(`unexpected ${method} ${path}`);
    }),
    subscribeEvents: vi.fn(() => () => undefined),
    close: vi.fn(),
  };
  const transport = createSharedAppTransport({ platform, direct: direct as never, target });
  render(<SharedAppViewer target={target} transport={transport} />);
  const frame = await screen.findByTitle("Notes shared by Owner") as HTMLIFrameElement;
  const listeners: Array<(event: { source: unknown; origin: string; data: unknown }) => void> = [];
  const parent = { postMessage: (data: unknown) => window.dispatchEvent(new MessageEvent("message", {
    source: frame.contentWindow, origin: "null", data,
  })) };
  const child = { MatrixOS: undefined as ReadOnlyBridge | undefined };
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((data) => {
    for (const listener of listeners) listener({ source: parent, origin: window.location.origin, data });
  });
  const script = collaborativeAppBridgeBootstrap({ readOnly }).replace(/^<script>|<\/script>$/g, "");
  await act(async () => { runInNewContext(script, {
    window: child, parent, location: { origin: window.location.origin }, crypto,
    document: { getElementById: () => ({ textContent: JSON.stringify({ actorId: "user_member", displayName: "Member" }) }) },
    addEventListener: (type: string, listener: typeof listeners[number]) => { if (type === "message") listeners.push(listener); else if (type === "pagehide") disposers.push(() => listener({ source: parent, origin: window.location.origin, data: null })); },
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), console,
  }); });
  return { bridge: child.MatrixOS!, direct };
}

it("serves the owner's records to an ordinary app through db.* on a view-only share", async () => {
  const { bridge, direct } = await setup(true);
  await act(async () => {
    await expect(bridge.db!.find("items", { where: { done: false }, orderBy: { id: "asc" }, limit: 20 })).resolves.toEqual(rows);
    await expect(bridge.db!.findOne("items", "note-1")).resolves.toEqual(rows[0]);
    await expect(bridge.db!.count("items")).resolves.toBe(1);
  });
  expect(direct.request).toHaveBeenCalledWith(scopeId, "POST", `${base}/view`,
    { action: { action: "find", table: "items", filter: { done: false }, orderBy: { id: "asc" }, limit: 20 } });
});

it("reads and unwraps the owner's key-value data", async () => {
  const { bridge } = await setup(true);
  await act(async () => { await expect(bridge.readData!("settings")).resolves.toEqual({ theme: "dark" }); });
});

it("refuses db and key-value writes locally without contacting the owner, and shows the notice", async () => {
  const { bridge, direct } = await setup(true);
  await act(async () => {
    await expect(bridge.db!.insert("items", { id: "x" })).rejects.toThrow("view-only");
    await expect(bridge.writeData!("settings", {})).rejects.toThrow("view-only");
  });
  expect(direct.request).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain("This app is view-only");
});

it("passes keys through for the owner to normalize like its own bridge", async () => {
  const { bridge, direct } = await setup(true);
  await act(async () => { await expect(bridge.readData!("clock.zones")).resolves.toBeNull(); });
  expect(direct.request).toHaveBeenCalledWith(scopeId, "GET", `${base}/data?key=clock.zones`);
});

it("clears an unconfirmed write when its retry is refused as view-only", async () => {
  const { bridge, direct } = await setup(true);
  direct.request.mockRejectedValueOnce(new CollaborationDirectError("unavailable"));
  await act(async () => { await expect(bridge.collaboration.mutate({ action: "insert", table: "items", data: { id: "x" } }, "0")).rejects.toThrow(); });
  expect(screen.getByText("Change not confirmed")).toBeTruthy();
  direct.request.mockRejectedValueOnce(new CollaborationDirectError("read_only", "This app is view-only"));
  await act(async () => { await expect(bridge.collaboration.retryMutation()).rejects.toThrow("view-only"); });
  expect(screen.queryByText("Change not confirmed")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("This app is view-only");
});

it("keeps the app open with an inline notice when the owner refuses a write as view-only", async () => {
  const { bridge, direct } = await setup(true);
  direct.request.mockRejectedValueOnce(new CollaborationDirectError("read_only", "This app is view-only"));
  await act(async () => {
    await expect(bridge.collaboration.mutate({ action: "insert", table: "items", data: { id: "x" } }, "0"))
      .rejects.toThrow("view-only");
  });
  expect(screen.queryByText("Access ended")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("This app is view-only");
});

it("installs no db or key-value bridge for a collaborative share", async () => {
  const { bridge } = await setup(false);
  expect(bridge.db).toBeUndefined();
  expect(bridge.readData).toBeUndefined();
});
