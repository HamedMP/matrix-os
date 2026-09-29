// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { ChatCollaboration } from "../../packages/ui/src/collaboration/ChatCollaboration";

const scopeId = "10000000-0000-4000-8000-000000000001";
const appId = "notes";
const catalogId = "20000000-0000-4000-8000-000000000001";
const base = `/api/collaboration/scopes/${scopeId}`;
const appPath = `${base}/apps/${appId}`;

function apiFor(readiness: "ready" | "blocked" | "unavailable" = "ready", collaborationMode: "scoped" | "unavailable" = "scoped", role: "viewer" | "editor" = "editor") {
  const assets: Record<string, { body: string; type: string }> = {
    "index.html": { body: "<!doctype html><html><head></head><body><h1>Notes</h1></body></html>", type: "text/html" },
  };
  const api = {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      if (path === base) return {
        id: scopeId, ownerId: "user_owner", kind: "app", resourceId: catalogId, membershipMode: "direct", lifecycle: "shared",
        revision: "1", authEpoch: "1", authorityGeneration: "1", role,
        capabilities: { read: true, discuss: false, manageMembers: false, requestAi: false, observeTerminal: false, controlTerminal: false, stopTerminal: false },
      };
      if (path === `${base}/apps`) return { appId, catalogId };
      if (path === appPath) return { appId, catalogId, revision: "3", readiness, collaborationMode };
      throw new Error(`unexpected ${path}`);
    }),
    getContent: vi.fn(async (path: string) => {
      const asset = assets[path.replace(`${appPath}/assets/`, "")];
      if (!asset) throw new Error("missing asset");
      const bytes = new TextEncoder().encode(asset.body);
      return { status: "ok" as const, bytes, contentType: asset.type, size: bytes.byteLength };
    }),
    post: vi.fn(async (_path: string, body: unknown) => body && typeof body === "object" && "expectedRevision" in body
      ? { result: { id: "row" }, revision: 4, replayed: false }
      : { result: [{ id: "row" }] }),
    delete: vi.fn(),
  };
  return { api, assets };
}

function show(api: ReturnType<typeof apiFor>["api"]) {
  return render(<ChatCollaboration view={{ kind: "app", scopeId }} api={api} actorId="user_ada" />);
}

function connectBridge(frame: HTMLIFrameElement) {
  const port = { postMessage: vi.fn(), close: vi.fn(), start: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };
  fireEvent(window, new MessageEvent("message", { data: { type: "matrix:app-bridge-ready", scopeId, appId },
    origin: "null", source: frame.contentWindow, ports: [port as unknown as MessagePort] }));
  return port;
}

function sendOnPort(port: ReturnType<typeof connectBridge>, action: Record<string, unknown>, id = 1) {
  port.onmessage?.({ data: { type: "matrix:app-query", scopeId, appId, id, action } } as MessageEvent);
}

describe("SharedAppView", () => {
  it("renders only a ready, scoped app in an opaque sandbox", async () => {
    const { api } = apiFor();
    show(api);
    const frame = await screen.findByTitle("Shared app");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("srcdoc", expect.stringContaining("window.MatrixOS"));
    expect(api.getContent).toHaveBeenCalledOnce();
  });

  it("returns the numeric count supplied by the scoped app query", async () => {
    const { api } = apiFor();
    show(api);
    const frame = await screen.findByTitle("Shared app") as HTMLIFrameElement;
    const document = new DOMParser().parseFromString(frame.srcdoc, "text/html");
    const script = document.querySelector("script")?.textContent;
    expect(script).toBeTruthy();
    const parent = { postMessage: vi.fn() };
    const port1 = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn() };
    class FakeMessageChannel { port1 = port1; port2 = {}; }
    const child = {} as { MatrixOS: { db: { count(table: string): Promise<number> } } };
    new Function("window", "parent", "MessageChannel", script!)(child, parent, FakeMessageChannel);
    const count = child.MatrixOS.db.count("notes");
    expect(port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: { app: appId, action: "count", table: "notes" },
    }));
    const request = port1.postMessage.mock.calls[0]![0] as { id: number };
    port1.onmessage?.({ data: { type: "matrix:app-result", id: request.id, ok: true, result: 7 } } as MessageEvent);
    await expect(count).resolves.toBe(7);
  });

  it("round trips a sticky note through the shared key-value helper", async () => {
    const { api } = apiFor();
    show(api);
    const frame = await screen.findByTitle("Shared app") as HTMLIFrameElement;
    const document = new DOMParser().parseFromString(frame.srcdoc, "text/html");
    const script = document.querySelector("script")?.textContent;
    const port1 = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn() };
    class FakeMessageChannel { port1 = port1; port2 = {}; }
    const child = {} as { MatrixOS: { writeData(key: string, value: unknown): Promise<void>; readData(key: string): Promise<unknown> } };
    new Function("window", "parent", "MessageChannel", script!)(child, { postMessage: vi.fn() }, FakeMessageChannel);
    const key = "win-sticky-notes/notes";
    const written = child.MatrixOS.writeData(key, [{ text: "Shared note" }]);
    const writeRequest = port1.postMessage.mock.calls[0]![0] as { id: number; action: { value: string } };
    expect(writeRequest.action.value).toBe(JSON.stringify({ value: [{ text: "Shared note" }] }));
    port1.onmessage?.({ data: { type: "matrix:app-result", id: writeRequest.id, ok: true, result: { ok: true } } } as MessageEvent);
    await expect(written).resolves.toBeUndefined();
    const read = child.MatrixOS.readData(key);
    const readRequest = port1.postMessage.mock.calls[1]![0] as { id: number; action: { key: string } };
    expect(readRequest.action.key).toBe(key);
    port1.onmessage?.({ data: { type: "matrix:app-result", id: readRequest.id, ok: true, result: writeRequest.action.value } } as MessageEvent);
    await expect(read).resolves.toEqual([{ text: "Shared note" }]);
  });

  it.each([
    ["blocked", "scoped"], ["unavailable", "scoped"], ["ready", "unavailable"],
  ] as const)("keeps %s/%s apps unavailable without fetching assets", async (readiness, mode) => {
    const { api } = apiFor(readiness, mode);
    show(api);
    expect(await screen.findByRole("alert")).toHaveTextContent("App unavailable");
    expect(screen.queryByTitle("Shared app")).toBeNull();
    expect(api.getContent).not.toHaveBeenCalled();
  });

  it("rejects other instances, other sources, and unknown actions", async () => {
    const { api } = apiFor();
    show(api);
    const frame = await screen.findByTitle("Shared app") as HTMLIFrameElement;
    await act(async () => {});
    const port = connectBridge(frame);
    const send = (data: unknown, source: MessageEventSource | null = frame.contentWindow) => {
      const event = new MessageEvent("message", { data, origin: "null", source, ports: [port as unknown as MessagePort] });
      fireEvent(window, event);
    };
    send({ type: "matrix:app-query", scopeId, appId: "other", action: { app: appId, action: "find", table: "notes" } });
    send({ type: "matrix:app-query", scopeId, appId, action: { app: appId, action: "find", table: "notes" } }, window);
    send({ type: "matrix:app-query", scopeId, appId, action: { app: appId, action: "listApps" } });
    expect(api.post).not.toHaveBeenCalled();
    send({ type: "matrix:app-query", scopeId, appId, action: { app: appId, action: "find", table: "notes" } });
    expect(api.post).not.toHaveBeenCalled();
    sendOnPort(port, { app: appId, action: "listApps" });
    expect(api.post).not.toHaveBeenCalled();
    sendOnPort(port, { app: appId, action: "find", table: "notes" });
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${appPath}/view`, { action: { app: appId, action: "find", table: "notes" } }));
  });

  it("binds app requests to the first document port and revokes it after navigation", async () => {
    const { api } = apiFor();
    show(api);
    const frame = await screen.findByTitle("Shared app") as HTMLIFrameElement;
    await act(async () => {});
    const port = connectBridge(frame);
    const query = { type: "matrix:app-query", scopeId, appId, action: { app: appId, action: "find", table: "notes" } };
    fireEvent(window, new MessageEvent("message", { data: query, origin: "null", source: frame.contentWindow,
      ports: [{ postMessage: vi.fn() } as unknown as MessagePort] }));
    expect(api.post).not.toHaveBeenCalled();
    await act(async () => { port.onmessage?.({ data: { ...query, id: 1 } } as MessageEvent); });
    expect(api.post).toHaveBeenCalledWith(`${appPath}/view`, { action: query.action });
    fireEvent.load(frame);
    fireEvent.load(frame);
    expect(await screen.findByRole("alert")).toHaveTextContent("App unavailable");
    expect(port.close).toHaveBeenCalled();
  });

  it("never sends a Viewer mutation to the home", async () => {
    const { api } = apiFor("ready", "scoped", "viewer");
    show(api);
    const frame = await screen.findByTitle("Shared app") as HTMLIFrameElement;
    await act(async () => {});
    const port = connectBridge(frame);
    sendOnPort(port, { app: appId, action: "insert", table: "notes", data: { title: "x" } });
    sendOnPort(port, { app: appId, action: "writeData", key: "win-sticky-notes/notes", value: "note" }, 2);
    expect(api.post).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith({ type: "matrix:app-result", id: 1, ok: false, error: "Action unavailable" });
    expect(port.postMessage).toHaveBeenCalledWith({ type: "matrix:app-result", id: 2, ok: false, error: "Action unavailable" });
  });

  it("inlines bounded local scripts and styles, and rejects remote scripts", async () => {
    const { api, assets } = apiFor();
    assets["index.html"] = { body: '<html><head><link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script></head><body>Notes</body></html>', type: "text/html" };
    assets["assets/app.css"] = { body: "body{color:blue}", type: "text/css" };
    assets["assets/app.js"] = { body: "window.loaded=true;", type: "text/javascript" };
    const rendered = show(api);
    const frame = await screen.findByTitle("Shared app");
    expect(frame.getAttribute("srcdoc")).toContain("body{color:blue}");
    expect(frame.getAttribute("srcdoc")).toContain("window.loaded%3Dtrue%3B");
    expect(frame.getAttribute("srcdoc")).not.toContain("/api/collaboration/scopes/");
    expect(api.getContent).toHaveBeenCalledWith(`${appPath}/assets/assets/app.js`, { maxBytes: 1024 * 1024 });
    rendered.unmount();

    assets["index.html"] = { body: '<html><head><script src="https://other.example/app.js"></script></head></html>', type: "text/html" };
    show(api);
    expect(await screen.findByRole("alert")).toHaveTextContent("App unavailable");
    expect(api.getContent).toHaveBeenCalledTimes(4);
  });

  it("resolves a Vite module chunk without exposing its asset URL", async () => {
    const { api, assets } = apiFor();
    assets["index.html"] = { body: '<html><head><link rel="modulepreload" href="./assets/vendor.js"><script type="module" src="./assets/app.js"></script></head></html>', type: "text/html" };
    assets["assets/app.js"] = { body: 'import{render}from"./vendor.js";render();', type: "text/javascript" };
    assets["assets/vendor.js"] = { body: "export const render=()=>42;", type: "text/javascript" };
    show(api);
    const frame = await screen.findByTitle("Shared app");
    expect(frame.getAttribute("srcdoc")).toContain("data%3Atext%2Fjavascript");
    expect(frame.getAttribute("srcdoc")).not.toContain("modulepreload");
    expect(api.getContent).toHaveBeenCalledWith(`${appPath}/assets/assets/vendor.js`, { maxBytes: 1024 * 1024 });
  });

  it("sends a Contributor mutation with the current revision and advances it after success", async () => {
    const { api } = apiFor();
    show(api);
    const frame = await screen.findByTitle("Shared app") as HTMLIFrameElement;
    await act(async () => {});
    const port = connectBridge(frame);
    const send = () => sendOnPort(port, { app: appId, action: "insert", table: "notes", data: { title: "x" } });
    send();
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenLastCalledWith(`${appPath}/actions`, {
      action: { app: appId, action: "insert", table: "notes", data: { title: "x" } },
      expectedRevision: "3", clientRequestId: expect.any(String),
    });
    await waitFor(() => expect(port.postMessage).toHaveBeenCalledWith({ type: "matrix:app-result", id: 1, ok: true, result: { id: "row" } }));
    send();
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post).toHaveBeenLastCalledWith(`${appPath}/actions`, expect.objectContaining({ expectedRevision: "4" }));
  });

  it("updates its revision after another collaborator changes the instance", async () => {
    const { api } = apiFor();
    let changed!: () => void | Promise<void>;
    const withEvents = { ...api, subscribe: vi.fn((_scope: string, onEvent: () => void | Promise<void>) => {
      changed = onEvent;
      return () => undefined;
    }) };
    show(withEvents);
    const frame = await screen.findByTitle("Shared app") as HTMLIFrameElement;
    await act(async () => {});
    api.get.mockImplementation(async (path: string) => {
      if (path === appPath) return { appId, catalogId, revision: "9", readiness: "ready", collaborationMode: "scoped" };
      throw new Error(`unexpected ${path}`);
    });
    await act(async () => { await changed(); });
    const port = connectBridge(frame);
    sendOnPort(port, { app: appId, action: "insert", table: "notes", data: { title: "x" } });
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${appPath}/actions`, expect.objectContaining({ expectedRevision: "9" })));
  });
});
