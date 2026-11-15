// @vitest-environment jsdom
import { runInNewContext } from "node:vm";
import { collaborativeAppBridgeBootstrap } from "../../packages/platform/src/collaboration/app-bridge-bootstrap";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SharedAppViewer } from "../../packages/ui/src/collaboration/SharedAppViewer";
import { createSharedAppTransport, type SharedAppTarget } from "../../packages/ui/src/collaboration/shared-app-transport";
import { CollaborationDirectError } from "../../packages/ui/src/collaboration/direct-client";

const scopeId = "10000000-0000-4000-8000-000000000001";
const target: SharedAppTarget = {
  scopeId, organizationId: "org_matrix", appId: "tasks", catalogId: "30000000-0000-4000-8000-000000000001",
  readinessId: "40000000-0000-4000-8000-000000000001", registrationIncarnation: "a".repeat(64), buildId: "b".repeat(64),
  shareRevision: "2", authorityGeneration: 1, runtimeId: "runtime_owner", owner: { actorId: "user_owner", displayName: "Owner" },
};
const saved = { result: { id: "task_one" }, revision: 1, replayed: true };
type Reply = { result: unknown; revision: string; replayed: boolean };
interface Bridge {
  mutate(action: unknown, revision: string): Promise<Reply>;
  retryMutation(): Promise<Reply>;
}
const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); cleanup(); vi.restoreAllMocks(); });

function injectedScript(): string {
  return collaborativeAppBridgeBootstrap().replace(/^<script>|<\/script>$/g, "");
}

async function setup() {
  const platform = { get: vi.fn(), post: vi.fn(async () => ({
    target: { kind: "shared", scopeId, organizationId: target.organizationId, appId: target.appId,
      catalogId: target.catalogId, buildId: target.buildId, name: "Tasks", owner: target.owner, shareRevision: target.shareRevision },
    launchId: "20000000-0000-4000-8000-000000000001", entryUrl: "/shared-fixture/index.html", expiresAt: "2026-11-15T02:00:00.000Z",
  })) };
  const direct = { request: vi.fn(async (_scope: string, _method: string, _path: string, _body: unknown) => saved), subscribeEvents: vi.fn(() => () => undefined), close: vi.fn() };
  const transport = createSharedAppTransport({ platform, direct: direct as never, target });
  const view = render(<SharedAppViewer target={target} transport={transport} />);
  const frame = await screen.findByTitle("Tasks shared by Owner") as HTMLIFrameElement;
  const listeners: Array<(event: { source: unknown; origin: string; data: unknown }) => void> = [];
  const parent = { postMessage: (data: unknown) => window.dispatchEvent(new MessageEvent("message", {
    source: frame.contentWindow, origin: "null", data,
  })) };
  const child = { MatrixOS: undefined as { collaboration: Bridge } | undefined };
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((data) => {
    for (const listener of listeners) listener({ source: parent, origin: window.location.origin, data });
  });
  await act(async () => { runInNewContext(injectedScript(), {
    window: child, parent, location: { origin: window.location.origin }, crypto,
    document: { getElementById: () => ({ textContent: JSON.stringify({ actorId: "user_member", displayName: "Member" }) }) },
    addEventListener: (type: string, listener: typeof listeners[number]) => { if (type === "message") listeners.push(listener); else if (type === "pagehide") disposers.push(() => listener({ source: parent, origin: window.location.origin, data: null })); },
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), console,
  }); });
  return { bridge: child.MatrixOS!.collaboration, transport, direct, view, post, frame };
}

it("lets the member retry an unconfirmed create through the real injected bridge with the same operation identity", async () => {
  const { bridge, direct } = await setup();
  direct.request.mockRejectedValueOnce(new CollaborationDirectError("unavailable"));
  await act(async () => { await expect(bridge.mutate({ action: "insert", app: "tasks", table: "tasks", data: { title: "Kept input" } }, "0")).rejects.toThrow(); });
  expect(screen.getByText("Change not confirmed")).toBeTruthy();
  expect(typeof bridge.retryMutation).toBe("function");
  await act(async () => { await expect(bridge.retryMutation()).resolves.toEqual({ ...saved, revision: "1" }); });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(direct.request).toHaveBeenCalledTimes(2);
  expect(direct.request.mock.calls[1]).toEqual(direct.request.mock.calls[0]);
});

it("shares one recovery between the app and the overlay and preserves the iframe", async () => {
  const { bridge, direct, frame } = await setup();
  direct.request.mockRejectedValueOnce(new CollaborationDirectError("unavailable"));
  await act(async () => { await expect(bridge.mutate({ action: "insert" }, "0")).rejects.toThrow(); });
  let finish!: (value: typeof saved) => void;
  direct.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let first!: Promise<Reply>, second!: Promise<Reply>;
  act(() => { first = bridge.retryMutation(); second = bridge.retryMutation(); });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(direct.request).toHaveBeenCalledTimes(2));
  await act(async () => { finish(saved); await expect(first).resolves.toMatchObject({ revision: "1" }); await expect(second).resolves.toMatchObject({ revision: "1" }); });
  expect(direct.request).toHaveBeenCalledTimes(2);
  expect(screen.getByTitle("Tasks shared by Owner")).toBe(frame);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not publish a successful recovery to a viewer after it unmounts", async () => {
  const { bridge, direct, view, post } = await setup();
  direct.request.mockRejectedValueOnce(new CollaborationDirectError("unavailable"));
  await act(async () => { await expect(bridge.mutate({ action: "insert" }, "0")).rejects.toThrow(); });
  let finish!: (value: typeof saved) => void;
  direct.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = bridge.retryMutation();
  void pending.catch(() => undefined);
  await waitFor(() => expect(direct.request).toHaveBeenCalledTimes(2));
  view.unmount(); post.mockClear();
  await act(async () => { finish(saved); });
  expect(post).not.toHaveBeenCalled();
  // Pagehide cleanup rejects the old document’s promise without replying to it.
});

it.each([
  ["denied", "Access ended"],
  ["invalid_request", "The app changed"],
] as const)("keeps a %s recovery failure visible and replies safely to the app", async (code, heading) => {
  const { bridge, direct } = await setup();
  direct.request.mockRejectedValueOnce(new CollaborationDirectError("unavailable"));
  await act(async () => { await expect(bridge.mutate({ action: "insert" }, "0")).rejects.toThrow(); });
  direct.request.mockRejectedValueOnce(new CollaborationDirectError(code));
  await act(async () => { await expect(bridge.retryMutation()).rejects.toThrow(); });
  expect(screen.getByText(heading)).toBeTruthy();
  expect(direct.request).toHaveBeenCalledTimes(2);
});

it("rejects forged or extended retry frames without sending any owner request", async () => {
  const { frame, direct, post } = await setup();
  for (const event of [
    { source: window, origin: "null", data: { type: "matrix:shared-app:retry", requestId: "req_forged" } },
    { source: frame.contentWindow, origin: "https://untrusted.invalid", data: { type: "matrix:shared-app:retry", requestId: "req_forged" } },
    { source: frame.contentWindow, origin: "null", data: { type: "matrix:shared-app:retry", requestId: "req_extended", action: { action: "insert" } } },
    { source: frame.contentWindow, origin: "null", data: { type: "matrix:shared-app:retry", requestId: "short" } },
  ]) act(() => { window.dispatchEvent(new MessageEvent("message", event)); });
  expect(direct.request).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

it("does not turn an empty retry queue into a new mutation", async () => {
  const { bridge, direct } = await setup();
  await act(async () => { await expect(bridge.retryMutation()).rejects.toThrow(); });
  expect(direct.request).not.toHaveBeenCalled();
  expect(screen.getByText("The app changed")).toBeTruthy();
});

it("keeps an overlay retry failure visible, then permits another recovery attempt", async () => {
  const { bridge, direct } = await setup();
  direct.request.mockRejectedValueOnce(new CollaborationDirectError("unavailable"));
  await act(async () => { await expect(bridge.mutate({ action: "insert" }, "0")).rejects.toThrow(); });
  direct.request.mockRejectedValueOnce(new CollaborationDirectError("unavailable"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry" })); });
  expect(screen.getByText("Change not confirmed")).toBeTruthy();
  await act(async () => { await expect(bridge.retryMutation()).resolves.toMatchObject({ revision: "1" }); });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(direct.request).toHaveBeenCalledTimes(3);
  expect(direct.request.mock.calls[2]).toEqual(direct.request.mock.calls[0]);
});
