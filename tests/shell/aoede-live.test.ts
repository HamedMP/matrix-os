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
    connectionState: "connected", onconnectionstatechange: null as null | (() => void),
    ontrack: null as null | ((event: RTCTrackEvent) => void),
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
  const onFailure = vi.fn(), onPhase = vi.fn(), onReconnecting = vi.fn(), onPlaybackBlocked = vi.fn();
  const media = new AoedeMedia({ gatewayUrl: "https://matrix.test", audio, fetchFn: fetchFn as typeof fetch,
    onEvent: vi.fn(), onFailure, onPhase, onReconnecting, onPlaybackBlocked });
  return { media, peer, channel, stop, fetchFn, audio, onFailure, onPhase, onReconnecting, onPlaybackBlocked };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("Aoede microphone and session ownership", () => {
  it("ends pending playback at 30 seconds and ignores late resolution without reminting", async () => {
    vi.useFakeTimers(); const s = setup(); await s.media.start(); s.media.started();
    let resolve!: () => void;
    vi.mocked(s.audio.play).mockImplementationOnce(() => new Promise<void>(r => { resolve = r; }));
    s.peer.ontrack?.({ streams: [{}] } as RTCTrackEvent);
    await vi.advanceTimersByTimeAsync(30000);
    expect(s.onFailure).toHaveBeenCalledExactlyOnceWith({ phase: "playback", code: "playback" });
    expect(s.stop).toHaveBeenCalledOnce();
    resolve(); await Promise.resolve(); await Promise.resolve();
    expect(s.onPlaybackBlocked).not.toHaveBeenCalled();
    expect(s.fetchFn.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    expect(s.fetchFn.mock.calls.filter(([, init]) => init.method === "DELETE")).toHaveLength(1);
  });
  it.each([[409, "conflict"], [429, "limited"], [401, "auth"], [403, "auth"], [502, "unavailable"], [503, "unavailable"]])("classifies mint HTTP %s without microphone blame", async (status, code) => {
    const s = setup(); s.fetchFn.mockResolvedValueOnce(new Response("{}", { status: Number(status) }));
    await expect(s.media.start()).rejects.toMatchObject({ failure: { phase: "mint", code } });
    expect(s.onFailure).toHaveBeenCalledWith({ phase: "mint", code });
  });
  it.each([["NotAllowedError", "denied"], ["NotFoundError", "device"], ["NotReadableError", "device"]])("classifies microphone %s", async (name, code) => {
    const s = setup(); vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(new DOMException("private", name));
    await expect(s.media.start()).rejects.toMatchObject({ failure: { phase: "microphone", code } });
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it("classifies malformed answers as transport and closes a validated funded session ID", async () => {
    const s = setup(); s.fetchFn.mockResolvedValueOnce(new Response(JSON.stringify({ sessionId, sdp: null })));
    await expect(s.media.start()).rejects.toMatchObject({ failure: { phase: "transport", code: "transport" } });
    expect(s.onFailure).toHaveBeenCalledExactlyOnceWith({ phase: "transport", code: "transport" });
    expect(s.fetchFn.mock.calls.filter(([, init]) => init.method === "DELETE")).toHaveLength(1);
    expect(s.peer.setRemoteDescription).not.toHaveBeenCalled();
  });
  it("classifies an invalid JSON answer as transport rather than microphone or mint denial", async () => {
    const s = setup(); s.fetchFn.mockResolvedValueOnce(new Response("not JSON"));
    await expect(s.media.start()).rejects.toMatchObject({ failure: { phase: "transport", code: "transport" } });
  });
  it("does not extend the playback cap on another denied gesture and cancels grace on explicit end", async () => {
    vi.useFakeTimers(); const s = setup(); await s.media.start(); s.media.started();
    vi.mocked(s.audio.play).mockRejectedValue(new DOMException("private", "NotAllowedError"));
    await s.media.resumePlayback(); await vi.advanceTimersByTimeAsync(29000); await s.media.resumePlayback();
    await vi.advanceTimersByTimeAsync(1000); expect(s.onFailure).toHaveBeenCalledOnce();
    const ended = setup(); await ended.media.start(); ended.media.started();
    ended.peer.connectionState = "disconnected"; ended.peer.onconnectionstatechange?.(); ended.media.close();
    await vi.advanceTimersByTimeAsync(30000); expect(ended.onFailure).not.toHaveBeenCalled(); expect(ended.stop).toHaveBeenCalledOnce();
  });
  it("waits on the same disconnected peer, cancels on recovery and never remints", async () => {
    vi.useFakeTimers(); const s = setup(); await s.media.start(); s.media.started();
    s.peer.connectionState = "disconnected"; s.peer.onconnectionstatechange?.();
    expect(s.onReconnecting).toHaveBeenLastCalledWith(true); expect(s.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9000);
    s.peer.connectionState = "connected"; s.peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(11000);
    expect(s.onReconnecting).toHaveBeenLastCalledWith(false); expect(s.onFailure).not.toHaveBeenCalled();
    expect(s.fetchFn.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1); s.media.close();
  });
  it.each(["failed", "closed", "expiry"])("ends a disconnected peer on %s exactly once", async (state) => {
    vi.useFakeTimers(); const s = setup(); await s.media.start(); s.media.started();
    s.peer.connectionState = "disconnected"; s.peer.onconnectionstatechange?.();
    if (state === "expiry") await vi.advanceTimersByTimeAsync(10000);
    else { s.peer.connectionState = state; s.peer.onconnectionstatechange?.(); }
    await vi.advanceTimersByTimeAsync(30000);
    expect(s.onFailure).toHaveBeenCalledExactlyOnceWith({ phase: "transport", code: "transport" });
    expect(s.stop).toHaveBeenCalledOnce(); expect(s.onReconnecting).toHaveBeenLastCalledWith(false);
  });
  it("recovers blocked playback by gesture without unmuting or reminting", async () => {
    vi.useFakeTimers(); const s = setup(); await s.media.start(); s.media.started(); s.media.setMuted(true);
    vi.mocked(s.audio.play).mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    s.peer.ontrack?.({ streams: [{}] } as RTCTrackEvent); await Promise.resolve(); await Promise.resolve();
    expect(s.onPlaybackBlocked).toHaveBeenLastCalledWith(true); expect(s.stop).not.toHaveBeenCalled();
    await s.media.resumePlayback(); await vi.advanceTimersByTimeAsync(30000);
    expect(s.onPlaybackBlocked).toHaveBeenLastCalledWith(false); expect(s.onFailure).not.toHaveBeenCalled();
    expect(s.fetchFn).toHaveBeenCalledOnce(); s.media.close();
  });
  it.each(["NotAllowedError", "NotSupportedError"])("bounds or terminates playback %s", async (name) => {
    vi.useFakeTimers(); const s = setup(); await s.media.start(); s.media.started();
    vi.mocked(s.audio.play).mockRejectedValue(new DOMException("private", name));
    s.peer.ontrack?.({ streams: [{}] } as RTCTrackEvent); await Promise.resolve(); await Promise.resolve();
    if (name === "NotAllowedError") { expect(s.stop).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(30000); }
    expect(s.onFailure).toHaveBeenCalledExactlyOnceWith({ phase: "playback", code: "playback" }); expect(s.stop).toHaveBeenCalledOnce();
  });
  it("fences late playback rejection and retains the post-answer started deadline", async () => {
    vi.useFakeTimers(); const s = setup(); await s.media.start();
    await vi.advanceTimersByTimeAsync(20000);
    expect(s.onFailure).toHaveBeenCalledExactlyOnceWith({ phase: "transport", code: "timeout" });
    const late = setup(); await late.media.start(); let reject!: (error: unknown) => void;
    vi.mocked(late.audio.play).mockImplementationOnce(() => new Promise((_r, r) => { reject = r; }));
    late.peer.ontrack?.({ streams: [{}] } as RTCTrackEvent); late.media.close();
    reject(new DOMException("blocked", "NotAllowedError")); await Promise.resolve(); await Promise.resolve();
    expect(late.onPlaybackBlocked).not.toHaveBeenCalledWith(true); expect(late.onFailure).not.toHaveBeenCalled();
  });
  it("mutes captured audio without pausing playback and unmutes the same track", async () => {
    const s = setup();
    const track = { kind: "audio", enabled: true, stop: s.stop };
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue({ getTracks: () => [track] } as unknown as MediaStream);
    await s.media.start();
    expect(s.peer.addTrack.mock.calls[0][0]).toBe(track);
    s.media.setMuted(true);
    expect(track.enabled).toBe(false);
    expect(s.audio.pause).not.toHaveBeenCalled();
    await s.media.resumePlayback();
    expect(track.enabled).toBe(false); // Output recovery cannot resume captured microphone audio.
    s.media.setMuted(false);
    expect(track.enabled).toBe(true);
    s.media.close();
    expect(s.stop).toHaveBeenCalledOnce();
  });
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
