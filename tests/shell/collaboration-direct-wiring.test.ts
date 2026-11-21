// @vitest-environment jsdom
/**
 * S06 / T033, T034: the shell creates the direct collaboration API, never
 * falls back to platform-side authorization, and ends every home session
 * when the actor's app session is cleared.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMatrixAppSession } from "../../shell/src/lib/sign-out";
import {
  closeShellCollaborationSessions,
  createShellCollaborationApi,
  releaseShellCollaborationApi,
} from "../../shell/src/lib/collaboration";

const scopeId = "10000000-0000-4000-8000-000000000201";

describe("shell direct collaboration wiring", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); closeShellCollaborationSessions(); });

  it("builds a direct API whose scope requests go to the home, not the platform", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Collaboration unavailable" }), {
      status: 503, headers: { "content-type": "application/json" },
    }));
    const api = createShellCollaborationApi("https://app.matrix-os.com");
    expect(api.direct.describe(scopeId).state).toBe("idle");
    await expect(api.get(`/api/collaboration/scopes/${scopeId}`)).rejects.toThrow("CollaborationUnavailable");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://app.matrix-os.com/api/collaboration/connections");
    expect(init?.credentials).toBe("same-origin");
    expect(new Headers(init?.headers).get("x-runtime-slot")).toBeNull();
    expect(api.direct.describe(scopeId).state).toBe("offline");
  });

  it("ends every direct session when the Matrix app session is cleared", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const first = createShellCollaborationApi("https://app.matrix-os.com");
    const second = createShellCollaborationApi("https://app.matrix-os.com");
    const closeFirst = vi.spyOn(first.direct, "close");
    const closeSecond = vi.spyOn(second.direct, "close");
    await clearMatrixAppSession();
    expect(closeFirst).toHaveBeenCalledTimes(1);
    expect(closeSecond).toHaveBeenCalledTimes(1);
    closeShellCollaborationSessions();
    expect(closeFirst).toHaveBeenCalledTimes(1);
  });


  it("refreshes Clerk proof before clearing app and collaboration sessions", async () => {
    let finish!: (value: string) => void;
    const getToken = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const api = createShellCollaborationApi("https://app.matrix-os.com");
    const close = vi.spyOn(api.direct, "close");
    const clearing = clearMatrixAppSession(getToken);
    expect(getToken).toHaveBeenCalledWith({ skipCache: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    finish("fresh-clerk-proof");
    await clearing;
    expect(new Headers(fetchSpy.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer fresh-clerk-proof");
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["empty", "unavailable"])("preserves local sessions when fresh proof is %s", async failure => {
    const getToken = vi.fn(async () => {
      if (failure === "unavailable") throw new Error("Offline");
      return null;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const api = createShellCollaborationApi("https://app.matrix-os.com");
    const close = vi.spyOn(api.direct, "close");
    await expect(clearMatrixAppSession(getToken)).rejects.toThrow("Sign-out is temporarily unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("bounds a stalled proof refresh and never sends delayed cleanup", async () => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    const getToken = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const clearing = clearMatrixAppSession(getToken);
    const rejected = expect(clearing).rejects.toThrow("Sign-out is temporarily unavailable");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    finish("late-token");
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shares one live client across more than 32 mounted viewers without evicting open windows", () => {
    const viewers = Array.from({ length: 33 }, () => createShellCollaborationApi("https://app.matrix-os.com"));
    const directClose = vi.spyOn(viewers[0]!.direct, "close");

    expect(new Set(viewers)).toHaveLength(1);
    for (const viewer of viewers.slice(0, -1)) releaseShellCollaborationApi(viewer);
    expect(directClose).not.toHaveBeenCalled();
    releaseShellCollaborationApi(viewers.at(-1)!);
    expect(directClose).toHaveBeenCalledOnce();
  });
});
