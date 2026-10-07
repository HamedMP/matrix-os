// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AoedeMedia } from "../../shell/src/aoede/media";
import { resolveAoedeApp, executeAoedeApp } from "../../shell/src/aoede/shell-actions";

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function setup() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  const channel = { readyState: "open", send: vi.fn(), close: vi.fn() };
  const peer = {
    createDataChannel: () => channel, addTrack: vi.fn(), close: vi.fn(),
    createOffer: async () => ({ type: "offer", sdp: "offer" }),
    setLocalDescription: vi.fn(), setRemoteDescription: vi.fn(),
    localDescription: { sdp: "offer" },
  };
  vi.stubGlobal("RTCPeerConnection", vi.fn(function () { return peer; }));
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } });
  const audio = { pause: vi.fn(), play: vi.fn(async () => undefined), srcObject: null } as unknown as HTMLAudioElement;
  const fetchFn = vi.fn(async (_url: string, init: RequestInit) => new Response(
    init.method === "POST" ? JSON.stringify({ sessionId, providerSessionId: "live_1", sdp: "answer" }) : "{}",
    { status: 200, headers: { "Content-Type": "application/json" } },
  ));
  const media = new AoedeMedia({ gatewayUrl: "https://matrix.test", audio, fetchFn: fetchFn as typeof fetch,
    onEvent: vi.fn(), onFailure: vi.fn() });
  return { media, peer, channel, stop, fetchFn, audio };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("Aoede microphone and session ownership", () => {
  it("does not mint when microphone permission is denied", async () => {
    const s = setup();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    await expect(s.media.start()).rejects.toThrow();
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it("releases capture and closes the funded session when applying the answer fails", async () => {
    const s = setup();
    s.peer.setRemoteDescription.mockRejectedValue(new Error("Bad answer"));
    await expect(s.media.start()).rejects.toThrow();
    expect(s.stop).toHaveBeenCalledOnce();
    expect(s.peer.close).toHaveBeenCalledOnce();
    expect(s.fetchFn.mock.calls.some(([, init]) => init.method === "DELETE" && JSON.parse(String(init.body)).sessionId === sessionId)).toBe(true);
  });
  it("dismissal during permission never mints and stops the late microphone stream", async () => {
    const s = setup();
    let resolve!: (stream: MediaStream) => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(() => new Promise((r) => { resolve = r; }));
    const starting = s.media.start();
    s.media.close();
    resolve({ getTracks: () => [{ stop: s.stop }] } as unknown as MediaStream);
    await expect(starting).rejects.toThrow();
    expect(s.stop).toHaveBeenCalledOnce();
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it("closes a late mint response without installing it after dismissal", async () => {
    const s = setup();
    let resolve!: (response: Response) => void;
    s.fetchFn.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const starting = s.media.start();
    await vi.waitFor(() => expect(s.fetchFn).toHaveBeenCalledOnce());
    s.media.close();
    resolve(new Response(JSON.stringify({ sessionId, providerSessionId: "live_1", sdp: "answer" })));
    await expect(starting).rejects.toThrow();
    expect(s.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(s.fetchFn).toHaveBeenCalledTimes(2);
  });
  it("dismissal stops capture and playback immediately and closes only its own session", async () => {
    const s = setup(); await s.media.start();
    s.media.close(); s.media.close();
    expect(s.stop).toHaveBeenCalledOnce(); expect(s.audio.pause).toHaveBeenCalledOnce();
    expect(s.audio.srcObject).toBeNull();
    expect(s.fetchFn.mock.calls.filter(([, init]) => init.method === "DELETE")).toHaveLength(1);
  });
});
describe("Aoede verified window effects", () => {
  const apps = [{ name: "Notes", slug: "notes", path: "apps/notes" }, { name: "Notes Archive", slug: "notes-archive", path: "apps/archive" }];
  it("asks for clarification instead of opening an arbitrary fuzzy match", () => {
    expect(resolveAoedeApp(apps, "note")).toEqual({ status: "ambiguous" });
    expect(resolveAoedeApp(apps, "the notes app")).toEqual({ status: "ok", slug: "notes" });
    expect(resolveAoedeApp(apps, "Notes")).toEqual({ status: "ok", slug: "notes" });
  });
  it("never reports success when the real open handler produced no window", () => {
    expect(executeAoedeApp(apps, "notes", "open_app", () => undefined, () => undefined, () => [])).toEqual({ status: "failed" });
  });
  it("does not open an external Browser tab whose outcome cannot be inspected", () => {
    const open = vi.fn();
    const result = executeAoedeApp([{ name: "Browser", slug: "browser", path: "apps/browser/index.html" }], "browser", "open_app", open, vi.fn(), () => []);
    expect(result.status).toBe("failed"); expect(open).not.toHaveBeenCalled();
  });
  it("checks the actual post-close window list, including minimized windows", () => {
    let windows = [{ id: "n1", path: "apps/notes", minimized: true }];
    const result = executeAoedeApp(apps, "notes", "close_app", () => undefined,
      (id) => { windows = windows.filter((w) => w.id !== id); }, () => windows);
    expect(result).toEqual({ status: "ok", slug: "notes" });
    expect(windows).toEqual([]);
  });
});
