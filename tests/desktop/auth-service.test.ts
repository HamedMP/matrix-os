import { describe, expect, it, vi } from "vitest";
import { AuthService, type ConnectionProfile } from "@desktop/main/auth/auth-service";
import type { CredentialStore, StoredCredential } from "@desktop/main/auth/credential-store";

function makeCredential(overrides: Partial<StoredCredential> = {}): StoredCredential {
  return {
    accessToken: "token-1",
    expiresAt: Date.now() + 60_000,
    userId: "user-1",
    handle: "neo",
    ...overrides,
  };
}

function makeProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    handle: "neo",
    userId: "user-1",
    platformHost: "https://app.matrix-os.com",
    runtimeSlot: "primary",
    ...overrides,
  };
}

function makeCredentialStore(initial: StoredCredential | null): CredentialStore & {
  saved: StoredCredential | null;
  cleared: boolean;
} {
  return {
    saved: null,
    cleared: false,
    async load() {
      return initial;
    },
    async save(credential) {
      this.saved = credential;
    },
    async clear() {
      this.cleared = true;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AuthService", () => {
  it("treats expired persisted credentials as signed out", async () => {
    const credentialStore = makeCredentialStore(makeCredential({ expiresAt: Date.now() - 1000 }));
    const clearProfile = vi.fn(async () => undefined);
    const auth = new AuthService({
      credentialStore,
      platformHost: "https://app.matrix-os.com",
      openExternal: vi.fn(async () => undefined),
      loadProfile: async () => makeProfile(),
      saveProfile: vi.fn(async () => undefined),
      clearProfile,
      onAuthChanged: vi.fn(),
    });

    await auth.init();

    expect(auth.getStatus().signedIn).toBe(false);
    expect(auth.getToken()).toBeNull();
    expect(credentialStore.cleared).toBe(true);
    expect(clearProfile).toHaveBeenCalledOnce();
  });

  it("reuses a pending device flow instead of launching parallel poll loops", async () => {
    const credentialStore = makeCredentialStore(null);
    let codeRequests = 0;
    const tokenPromise = new Promise<Response>(() => undefined);
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/auth/device/code")) {
        codeRequests += 1;
        return jsonResponse({
          deviceCode: "device-1",
          userCode: "ABCD",
          verificationUri: "https://app.matrix-os.com/device",
          expiresIn: 600,
          interval: 5,
        });
      }
      return tokenPromise;
    });
    const auth = new AuthService({
      credentialStore,
      platformHost: "https://app.matrix-os.com",
      fetchFn,
      openExternal: vi.fn(async () => undefined),
      loadProfile: async () => null,
      saveProfile: vi.fn(async () => undefined),
      clearProfile: vi.fn(async () => undefined),
      onAuthChanged: vi.fn(),
    });

    const first = await auth.startDeviceFlow();
    const second = await auth.startDeviceFlow();

    expect(first).toEqual(second);
    expect(codeRequests).toBe(1);
  });

  it("does not restore credentials when an in-flight poll resolves after sign-out", async () => {
    const credentialStore = makeCredentialStore(null);
    const saveProfile = vi.fn(async () => undefined);
    const onAuthChanged = vi.fn();
    let resolveToken!: (response: Response) => void;
    const tokenPromise = new Promise<Response>((resolve) => {
      resolveToken = resolve;
    });
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/auth/device/code")) {
        return jsonResponse({
          deviceCode: "device-1",
          userCode: "ABCD",
          verificationUri: "https://app.matrix-os.com/device",
          expiresIn: 600,
          interval: 5,
        });
      }
      return tokenPromise;
    });
    const auth = new AuthService({
      credentialStore,
      platformHost: "https://app.matrix-os.com",
      fetchFn,
      openExternal: vi.fn(async () => undefined),
      loadProfile: async () => null,
      saveProfile,
      clearProfile: vi.fn(async () => undefined),
      onAuthChanged,
    });

    await auth.startDeviceFlow();
    await auth.signOut();
    resolveToken(
      jsonResponse({
        accessToken: "late-token",
        expiresAt: Date.now() + 60_000,
        userId: "user-1",
        handle: "neo",
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(auth.getStatus().signedIn).toBe(false);
    expect(credentialStore.saved).toBeNull();
    expect(saveProfile).not.toHaveBeenCalled();
    expect(onAuthChanged).toHaveBeenCalledTimes(1);
  });

  it("emits signed-out status before persistent sign-out cleanup can fail", async () => {
    const credentialStore = makeCredentialStore(makeCredential());
    const onAuthChanged = vi.fn();
    const cleanupError = new Error("credential clear failed");
    credentialStore.clear = vi.fn(async () => {
      throw cleanupError;
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const auth = new AuthService({
      credentialStore,
      platformHost: "https://app.matrix-os.com",
      openExternal: vi.fn(async () => undefined),
      loadProfile: async () => makeProfile(),
      saveProfile: vi.fn(async () => undefined),
      clearProfile: vi.fn(async () => undefined),
      onAuthChanged,
    });
    await auth.init();

    await expect(auth.signOut()).rejects.toThrow(cleanupError);

    expect(auth.getStatus().signedIn).toBe(false);
    expect(onAuthChanged).toHaveBeenCalledWith({
      signedIn: false,
      runtimeSlot: "primary",
      platformHost: "https://app.matrix-os.com",
    });
  });

  it("does not start polling when sign-out races an in-flight device-code request", async () => {
    const credentialStore = makeCredentialStore(null);
    const saveProfile = vi.fn(async () => undefined);
    const openExternal = vi.fn(async () => undefined);
    let resolveCode!: (response: Response) => void;
    const codePromise = new Promise<Response>((resolve) => {
      resolveCode = resolve;
    });
    let tokenRequests = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/auth/device/code")) return codePromise;
      tokenRequests += 1;
      return jsonResponse({
        accessToken: "late-token",
        expiresAt: Date.now() + 60_000,
        userId: "user-1",
        handle: "neo",
      });
    });
    const auth = new AuthService({
      credentialStore,
      platformHost: "https://app.matrix-os.com",
      fetchFn,
      openExternal,
      loadProfile: async () => null,
      saveProfile,
      clearProfile: vi.fn(async () => undefined),
      onAuthChanged: vi.fn(),
    });

    const flow = auth.startDeviceFlow();
    await Promise.resolve();
    await auth.signOut();
    resolveCode(
      jsonResponse({
        deviceCode: "device-1",
        userCode: "ABCD",
        verificationUri: "https://app.matrix-os.com/device",
        expiresIn: 600,
        interval: 5,
      }),
    );

    await expect(flow).rejects.toThrow("Sign-in request was canceled.");
    expect(auth.getStatus().signedIn).toBe(false);
    expect(tokenRequests).toBe(0);
    expect(openExternal).not.toHaveBeenCalled();
    expect(credentialStore.saved).toBeNull();
    expect(saveProfile).not.toHaveBeenCalled();
  });
});
