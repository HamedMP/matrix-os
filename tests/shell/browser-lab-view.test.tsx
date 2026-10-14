// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppViewer } from "../../shell/src/components/AppViewer";

const gateway = vi.hoisted(() => ({ current: "https://app.matrix-os.com/vm/pr-2526" }));
vi.mock("../../shell/src/lib/gateway", () => ({ getGatewayUrl: () => gateway.current }));
vi.mock("../../shell/src/hooks/useSocket", () => ({ useSocket: () => ({ send: vi.fn(), subscribe: () => () => {} }) }));
vi.mock("../../shell/src/hooks/useFileWatcher", () => ({ useFileWatcher: () => {} }));
vi.mock("../../shell/src/lib/posthog-client", () => ({ capturePostHogEvent: () => {} }));
const status = { phase: "idle", engine: null, generation: 0, checkpoint: 0, workCompleted: 0, message: "ready", updatedAt: "", humanControlAvailable: false };
let phase = { ...status };
let calls: Array<[string, RequestInit | undefined]>;
beforeEach(() => {
  phase = { ...status }; calls = []; gateway.current = "https://app.matrix-os.com/vm/pr-2526";
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    calls.push([String(url), options]);
    if (url.endsWith("/api/apps/browser-lab/session")) return Response.json({ expiresAt: Date.now() + 600_000 });
    if (url.endsWith("/api/status")) return Response.json(phase, { headers: { "x-matrix-browser-lab-comparison": "enabled" } });
    if (url.endsWith("/api/viewer-session")) return Response.json({ ticket: "a".repeat(48), expiresAt: Date.now() + 60_000 });
    if (url.endsWith("/api/control")) {
      const body = JSON.parse(String(options?.body));
      if (body.action === "takeover") phase = { ...phase, phase: "human", humanControlAvailable: true };
      if (body.action === "start") phase = { ...phase, phase: "running", engine: body.engine };
      return Response.json(phase);
    }
    throw new Error("Owner app HTML must not be fetched for trusted lab");
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("trusted Browser Lab shell surface", () => {
  it.each(["apps/browser-lab", "apps/browser-lab/index.html", "matrix-app:browser-lab"])("renders compiled controls for %s without executing owner HTML", async (path) => {
    render(<AppViewer path={path} />);
    const frame = await screen.findByTitle("Live VPS Chrome including password manager windows") as HTMLIFrameElement;
    await waitFor(() => expect(frame.src).toContain("/vm/pr-2526/apps/browser-lab/viewer/"));
    expect(frame.getAttribute("srcdoc")).toBeNull();
    const viewerUrl = new URL(frame.src);
    expect(viewerUrl.searchParams.get("resize")).toBe("scale");
    expect(viewerUrl.searchParams.get("path")).toBe(`vm/pr-2526/apps/browser-lab/viewer/websockify?lab_ticket=${"a".repeat(48)}`);
    expect(calls.every(([url]) => url.startsWith("https://app.matrix-os.com/vm/pr-2526/"))).toBe(true);
    expect(calls.some(([url]) => url === "https://app.matrix-os.com/vm/pr-2526/apps/browser-lab/")).toBe(false);
  });
  it("does not allow human input until server acknowledges takeover", async () => {
    render(<AppViewer path="apps/browser-lab" />);
    const frame = await screen.findByTitle("Live VPS Chrome including password manager windows");
    expect(frame.hasAttribute("inert")).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Take over" }));
    await waitFor(() => expect(frame.hasAttribute("inert")).toBe(false));
    expect(calls.find(([url]) => url.endsWith("/api/control"))?.[1]?.body).toBe('{"action":"takeover"}');
  });
  it("sends selected tool through the explicit test runtime", async () => {
    render(<AppViewer path="apps/browser-lab" />);
    await screen.findByTitle("Live VPS Chrome including password manager windows");
    fireEvent.click(screen.getByRole("button", { name: "Browser Use" }));
    fireEvent.click(screen.getByRole("button", { name: "Run comparison" }));
    await waitFor(() => expect(calls.find(([url]) => url.endsWith("/api/control"))?.[1]?.body).toBe('{"action":"start","engine":"browser-use"}'));
    expect(screen.getByTitle("Live VPS Chrome including password manager windows").hasAttribute("inert")).toBe(true);
  });
  it("blocks human input if a resume request fails without a fresh server acknowledgement", async () => {
    phase = { ...status, phase: "human", engine: "agent-browser" as any, humanControlAvailable: true };
    const normalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, options) => String(url).endsWith("/api/control")
      ? new Response("private provider detail", { status: 500 }) : normalFetch(url as string, options));
    render(<AppViewer path="apps/browser-lab" />);
    const frame = await screen.findByTitle("Live VPS Chrome including password manager windows");
    await waitFor(() => expect(frame.hasAttribute("inert")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await screen.findByRole("alert");
    expect(frame.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("alert").textContent).not.toContain("private");
  });
  it("does not accept polling state while a control acknowledgement is outstanding", async () => {
    const pollCallbacks: Array<() => void> = [];
    const normalTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
      if (delay === 1500) { pollCallbacks.push(callback); return -1; }
      return normalTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    let finishControl!: (value: Response) => void;
    const normalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, options) => String(url).endsWith("/api/control")
      ? new Promise<Response>((resolve) => { finishControl = resolve; }) : normalFetch(url as string, options));
    render(<AppViewer path="apps/browser-lab" />);
    await screen.findByTitle("Live VPS Chrome including password manager windows");
    fireEvent.click(screen.getByRole("button", { name: "Run comparison" }));
    phase = { ...phase, generation: 3, phase: "completed", checkpoint: 3, workCompleted: 10 };
    await act(async () => { pollCallbacks.shift()?.(); });
    const polledProgress = screen.getByText(/\/10 actions/).textContent;
    await act(async () => { finishControl(Response.json({ ...status, generation: 2, phase: "running", engine: "agent-browser", workCompleted: 1 })); });
    expect(polledProgress).toBe("0/10 actions");
    expect(screen.getByText("1/10 actions")).toBeTruthy();
  });
  it("keeps newer observed state when a control response has an older generation", async () => {
    phase = { ...status, generation: 5, phase: "running", engine: "agent-browser" as any, checkpoint: 2, workCompleted: 9 };
    const normalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, options) => String(url).endsWith("/api/control")
      ? Response.json({ ...status, generation: 4, phase: "human", humanControlAvailable: true }) : normalFetch(url as string, options));
    render(<AppViewer path="apps/browser-lab" />);
    const frame = await screen.findByTitle("Live VPS Chrome including password manager windows");
    await screen.findByText("9/10 actions");
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(screen.queryByText("Applying action…")).toBeNull());
    expect(screen.getByText("9/10 actions")).toBeTruthy();
    expect(frame.hasAttribute("inert")).toBe(true);
  });
  it("remounts on runtime change, removes the old viewer, and aborts old requests", async () => {
    const normalFetch = vi.mocked(fetch).getMockImplementation()!;
    let oldSignal: AbortSignal | undefined;
    let finishOldControl!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      if (String(url).includes("/vm/pr-2526/") && String(url).endsWith("/api/control")) {
        oldSignal = options?.signal as AbortSignal;
        return new Promise<Response>((resolve) => { finishOldControl = resolve; });
      }
      if (String(url).includes("/vm/pr-new/")) return Response.json({ error: "Unavailable" }, { status: 503 });
      return normalFetch(url as string, options);
    });
    const { rerender } = render(<AppViewer path="apps/browser-lab" />);
    await screen.findByTitle("Live VPS Chrome including password manager windows");
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    gateway.current = "https://app.matrix-os.com/vm/pr-new";
    rerender(<AppViewer path="apps/browser-lab" />);
    expect(screen.queryByTitle("Live VPS Chrome including password manager windows")).toBeNull();
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => { finishOldControl(Response.json({ ...status, phase: "human", humanControlAvailable: true })); });
    expect(screen.queryByTitle("Live VPS Chrome including password manager windows")).toBeNull();
    expect(screen.queryByText("You are in control")).toBeNull();
  });
  it("keeps every other app in the generic opaque srcDoc sandbox", async () => {
    vi.mocked(fetch).mockImplementation(async (url) => String(url).endsWith("/session") ? Response.json({ expiresAt: Date.now() + 600_000 }) : new Response('<html><head></head><body>Other app</body></html>'));
    render(<AppViewer path="apps/notes" />);
    const frame = screen.getByTitle("apps/notes");
    await waitFor(() => expect(frame.getAttribute("srcdoc")).toContain("window.MatrixOS"));
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("src")).toBe("about:blank");
  });
});
