// @vitest-environment jsdom
/**
 * S06 / T033, T034: the shell creates the direct collaboration API, never
 * falls back to platform-side authorization, and ends every home session
 * when the actor's app session is cleared.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMatrixAppSession } from "../../shell/src/lib/sign-out";
import { closeShellCollaborationSessions, createShellCollaborationApi } from "../../shell/src/lib/collaboration";

const scopeId = "10000000-0000-4000-8000-000000000201";

describe("shell direct collaboration wiring", () => {
  afterEach(() => { vi.restoreAllMocks(); closeShellCollaborationSessions(); });

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
});
