import { describe, expect, it, vi } from "vitest";
import { AuthService } from "@desktop/main/auth/auth-service";

async function harness(fetchFn: (url: string, init?: RequestInit) => Promise<Response>) {
  const clear = vi.fn(async () => {});
  const auth = new AuthService({
    credentialStore: { load: async () => ({ accessToken: "token", expiresAt: Date.now() + 3600000, userId: "user-1", handle: "neo" }), save: async () => {}, clear },
    platformHost: "https://app.matrix-os.com", runtimeSelectionOrigin: "https://api.matrix-os.com", fetchFn,
    loadProfile: async () => ({ handle: "neo", userId: "user-1", platformHost: "https://app.matrix-os.com", runtimeSlot: "primary" }),
    saveProfile: async () => {}, clearProfile: async () => {}, onAuthChanged: vi.fn(),
  });
  await auth.init();
  return { auth, clear };
}

describe("session revalidation after a feature 401", () => {
  it.each([200, 403, 429, 503])("retains the credential for verification status %s", async (status) => {
    const fetchFn = vi.fn(async () => new Response(null, { status }));
    const { auth, clear } = await harness(fetchFn);
    await auth.revalidateSession(auth.getStatus().authGeneration);
    expect(auth.getStatus().signedIn).toBe(true);
    expect(clear).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledWith("https://api.matrix-os.com/api/auth/computers", expect.objectContaining({ signal: expect.any(AbortSignal), redirect: "error" }));
  });

  it("expires a credential only after the authority rejects it", async () => {
    const { auth, clear } = await harness(async () => new Response(null, { status: 401 }));
    await auth.revalidateSession(auth.getStatus().authGeneration);
    expect(auth.getStatus().signedIn).toBe(false);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("retains the session on network failure", async () => {
    const { auth, clear } = await harness(async () => { throw new TypeError("offline"); });
    await auth.revalidateSession(auth.getStatus().authGeneration);
    expect(clear).not.toHaveBeenCalled();
  });

  it("ignores reports from an older credential generation", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 401 }));
    const { auth } = await harness(fetchFn);
    await auth.revalidateSession(auth.getStatus().authGeneration - 1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("coalesces concurrent failures into one verification", async () => {
    let finish!: (response: Response) => void;
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const { auth } = await harness(fetchFn);
    const generation = auth.getStatus().authGeneration;
    const first = auth.revalidateSession(generation);
    const second = auth.revalidateSession(generation);
    finish(new Response(null, { status: 200 }));
    await Promise.all([first, second]);
    expect(fetchFn).toHaveBeenCalledOnce();
  });
  it("ignores a verification response after a runtime credential replacement", async () => {
    let finish!: (response: Response) => void;
    const { auth, clear } = await harness(async (url) => {
      if (url.endsWith("/runtime-selection")) return Response.json({ accessToken: "s".repeat(64), expiresAt: Date.now() + 3600000, handle: "neo-review", slot: "review" });
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    const checking = auth.revalidateSession(auth.getStatus().authGeneration);
    await auth.selectRuntime("review");
    finish(new Response(null, { status: 401 }));
    await checking;
    expect(auth.getStatus()).toMatchObject({ signedIn: true, runtimeSlot: "review" });
    expect(clear).not.toHaveBeenCalled();
  });

});
