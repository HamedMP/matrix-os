import { describe, expect, it, vi } from "vitest";
import { AuthService, type AuthStatus, type ConnectionProfile } from "@desktop/main/auth/auth-service";
import type { CredentialStore, StoredCredential } from "@desktop/main/auth/credential-store";

const HOUR_MS = 3_600_000;

function makeCredentialStore(initial: StoredCredential | null = null) {
  let stored = initial;
  const store: CredentialStore = {
    save: vi.fn(async (credential: StoredCredential) => {
      stored = credential;
    }),
    load: vi.fn(async () => stored),
    clear: vi.fn(async () => {
      stored = null;
    }),
  };
  return { store, peek: () => stored };
}

function makeService(opts: {
  credential?: StoredCredential | null;
  profile?: ConnectionProfile | null;
  now: number | (() => number);
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
  saveProfile?: (profile: ConnectionProfile) => Promise<void>;
}) {
  const { store, peek } = makeCredentialStore(opts.credential ?? null);
  let profile = opts.profile ?? null;
  const changes: AuthStatus[] = [];
  const auth = new AuthService({
    credentialStore: store,
    platformHost: "https://app.matrix-os.com",
    runtimeSelectionOrigin: "https://api.matrix-os.com",
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    now: () => (typeof opts.now === "function" ? opts.now() : opts.now),
    loadProfile: async () => profile,
    saveProfile: async (nextProfile) => {
      if (opts.saveProfile) await opts.saveProfile(nextProfile);
      profile = nextProfile;
    },
    clearProfile: async () => {
      profile = null;
    },
    onAuthChanged: (status) => changes.push(status),
  });
  return { auth, store, changes, getProfile: () => profile, peekCredential: peek };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function flushAuthFlow(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const VALID: StoredCredential = {
  accessToken: "tok",
  expiresAt: 10_000 + HOUR_MS,
  userId: "user-1",
  handle: "neo",
};

const PROFILE: ConnectionProfile = {
  handle: "neo",
  userId: "user-1",
  platformHost: "https://app.matrix-os.com",
  runtimeSlot: "primary",
  displayName: "Thomas Anderson",
};

describe("AuthService token expiry", () => {
  it("reports signed-in and returns the token while the credential is valid", async () => {
    const { auth } = makeService({ credential: VALID, profile: PROFILE, now: 10_000 });
    await auth.init();
    expect(auth.getStatus().signedIn).toBe(true);
    expect(auth.getStatus().displayName).toBe("Thomas Anderson");
    expect(auth.getToken()).toBe("tok");
  });

  it("does not throw when expired credential cleanup fails during init", async () => {
    const { auth, store, getProfile } = makeService({
      credential: { ...VALID, expiresAt: 9_000 },
      profile: PROFILE,
      now: 10_000,
    });
    vi.mocked(store.clear).mockRejectedValueOnce(new Error("credential clear failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(auth.init()).resolves.toBeUndefined();

      expect(auth.getStatus().signedIn).toBe(false);
      expect(auth.getToken()).toBeNull();
      expect(store.clear).toHaveBeenCalledOnce();
      expect(getProfile()).toEqual(PROFILE);
      expect(console.warn).toHaveBeenCalledWith("[auth] failed to clear expired credential:", "credential clear failed");
    } finally {
      warn.mockRestore();
    }
  });

  it("emits signed-out status when an in-memory credential expires mid-session", async () => {
    let now = 10_000;
    const { auth, store, changes, getProfile } = makeService({
      credential: VALID,
      profile: PROFILE,
      now: () => now,
    });
    await auth.init();
    expect(auth.getStatus().signedIn).toBe(true);

    now = 10_000 + HOUR_MS;

    expect(auth.getStatus()).toMatchObject({
      signedIn: false,
      runtimeSlot: "primary",
      platformHost: "https://app.matrix-os.com",
    });
    expect(auth.getToken()).toBeNull();
    expect(changes).toHaveLength(1);
    expect(changes.at(-1)).toMatchObject({
      signedIn: false,
      runtimeSlot: "primary",
      platformHost: "https://app.matrix-os.com",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.clear).toHaveBeenCalledOnce();
    expect(getProfile()).toEqual(PROFILE);
  });

  it("treats an expired credential as signed-out and withholds the token", async () => {
    const { auth, store, getProfile } = makeService({
      credential: { ...VALID, expiresAt: 9_000 },
      profile: PROFILE,
      now: 10_000,
    });
    await auth.init();
    expect(auth.getStatus().signedIn).toBe(false);
    expect(auth.getToken()).toBeNull();
    expect(store.clear).toHaveBeenCalledOnce();
    expect(getProfile()).toEqual(PROFILE);
  });

  it("withholds the token within the refresh skew window before exact expiry", async () => {
    const { auth } = makeService({
      credential: { ...VALID, expiresAt: 15_000 },
      profile: PROFILE,
      now: 10_000,
    });
    await auth.init();
    expect(auth.getToken()).toBeNull();
    expect(auth.getStatus().signedIn).toBe(false);
  });
});

describe("AuthService runtime selection", () => {
  it("exchanges and persists a slot-bound credential before changing runtime", async () => {
    const replacementToken = "r".repeat(64);
    const fetchFn = vi.fn(async () => jsonResponse({
      accessToken: replacementToken,
      expiresAt: 1_800_000_000_000,
      handle: "neo-review",
      slot: "review",
    }));
    const { auth, getProfile, peekCredential } = makeService({
      credential: VALID,
      profile: PROFILE,
      now: 10_000,
      fetchFn,
    });
    await auth.init();

    await auth.selectRuntime("review");

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.matrix-os.com/api/auth/runtime-selection");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        authorization: `Bearer ${VALID.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ slot: "review" }),
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(peekCredential()).toEqual({
      accessToken: replacementToken,
      expiresAt: 1_800_000_000_000,
      userId: "user-1",
      handle: "neo-review",
    });
    expect(getProfile()).toEqual({
      ...PROFILE,
      handle: "neo-review",
      runtimeSlot: "review",
    });
    expect(auth.getStatus()).toMatchObject({
      signedIn: true,
      handle: "neo-review",
      runtimeSlot: "review",
    });
  });

  it("keeps the current credential and profile when the exchange fails", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "private upstream detail" }, 503));
    const { auth, getProfile, peekCredential } = makeService({
      credential: VALID,
      profile: PROFILE,
      now: 10_000,
      fetchFn,
    });
    await auth.init();

    await expect(auth.selectRuntime("review")).rejects.toThrow("Computer switch failed. Try again.");

    expect(peekCredential()).toEqual(VALID);
    expect(getProfile()).toEqual(PROFILE);
    expect(auth.getStatus().runtimeSlot).toBe("primary");
  });

  it("rejects oversized exchange responses without replacing trusted state", async () => {
    const fetchFn = vi.fn(async () => new Response("x".repeat(16 * 1024 + 1), { status: 200 }));
    const { auth, getProfile, peekCredential } = makeService({
      credential: VALID,
      profile: PROFILE,
      now: 10_000,
      fetchFn,
    });
    await auth.init();

    await expect(auth.selectRuntime("review")).rejects.toThrow("Computer switch failed. Try again.");

    expect(peekCredential()).toEqual(VALID);
    expect(getProfile()).toEqual(PROFILE);
  });
});

describe("AuthService device flow", () => {
  it("exchanges a fresh device credential before restoring a non-primary runtime", async () => {
    const replacementToken = "s".repeat(64);
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
      if (url === "https://api.matrix-os.com/api/auth/runtime-selection") {
        return jsonResponse({
          accessToken: replacementToken,
          expiresAt: 1_800_000_000_000,
          handle: "neo-review",
          slot: "review",
        });
      }
      return jsonResponse({
        accessToken: "fresh-device-token",
        expiresAt: 1_800_000_000_000,
        userId: "user-1",
        handle: "neo",
      });
    });
    const { auth, getProfile, peekCredential } = makeService({
      profile: { ...PROFILE, runtimeSlot: "review" },
      now: 10_000,
      fetchFn,
    });
    await auth.init();

    await auth.startDeviceFlow();
    await flushAuthFlow();

    expect(auth.getStatus()).toMatchObject({
      signedIn: true,
      handle: "neo-review",
      runtimeSlot: "review",
    });
    expect(peekCredential()).toMatchObject({
      accessToken: replacementToken,
      handle: "neo-review",
    });
    expect(getProfile()).toMatchObject({
      handle: "neo-review",
      runtimeSlot: "review",
    });
  });

  it("falls back to primary when a non-primary re-auth exchange is unavailable", async () => {
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
      if (url === "https://api.matrix-os.com/api/auth/runtime-selection") {
        return jsonResponse({ error: "unavailable" }, 503);
      }
      return jsonResponse({
        accessToken: "fresh-device-token",
        expiresAt: 1_800_000_000_000,
        userId: "user-1",
        handle: "neo",
      });
    });
    const { auth, getProfile, peekCredential } = makeService({
      profile: { ...PROFILE, runtimeSlot: "review" },
      now: 10_000,
      fetchFn,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await auth.init();
      await auth.startDeviceFlow();
      await flushAuthFlow();

      expect(auth.getStatus()).toMatchObject({
        signedIn: true,
        handle: "neo",
        runtimeSlot: "primary",
      });
      expect(peekCredential()).toMatchObject({ accessToken: "fresh-device-token", handle: "neo" });
      expect(getProfile()).toMatchObject({ handle: "neo", runtimeSlot: "primary" });
    } finally {
      warn.mockRestore();
    }
  });

  it("reuses a pending device flow instead of launching parallel poll loops", async () => {
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
    const { auth } = makeService({ now: 10_000, fetchFn });

    const first = await auth.startDeviceFlow();
    const second = await auth.startDeviceFlow();

    expect(first).toEqual(second);
    expect(codeRequests).toBe(1);
  });

  it("does not restore credentials when an in-flight poll resolves after sign-out", async () => {
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
    const { auth, changes, getProfile, peekCredential } = makeService({ now: 10_000, fetchFn });

    await auth.startDeviceFlow();
    await auth.signOut();
    resolveToken(
      jsonResponse({
        accessToken: "late-token",
        expiresAt: 10_000 + HOUR_MS,
        userId: "user-1",
        handle: "neo",
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(auth.getStatus().signedIn).toBe(false);
    expect(peekCredential()).toBeNull();
    expect(getProfile()).toBeNull();
    expect(changes).toHaveLength(1);
  });

  it("clears a credential save that completes after sign-out invalidates the device flow", async () => {
    let stored: StoredCredential | null = null;
    let profile: ConnectionProfile | null = null;
    const saveStarted = deferred<void>();
    const finishSave = deferred<void>();
    const credentialStore: CredentialStore = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (credential) => {
        saveStarted.resolve();
        await finishSave.promise;
        stored = credential;
      }),
      clear: vi.fn(async () => {
        stored = null;
      }),
    };
    const saveProfile = vi.fn(async (nextProfile: ConnectionProfile) => {
      profile = nextProfile;
    });
    const clearProfile = vi.fn(async () => {
      profile = null;
    });
    const changes: AuthStatus[] = [];
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
      return jsonResponse({
        accessToken: "late-token",
        expiresAt: 10_000 + HOUR_MS,
        userId: "user-1",
        handle: "neo",
      });
    });
    const auth = new AuthService({
      credentialStore,
      platformHost: "https://app.matrix-os.com",
      runtimeSelectionOrigin: "https://api.matrix-os.com",
      fetchFn,
      now: () => 10_000,
      loadProfile: async () => profile,
      saveProfile,
      clearProfile,
      onAuthChanged: (status) => changes.push(status),
    });

    await auth.startDeviceFlow();
    await saveStarted.promise;
    await auth.signOut();
    finishSave.resolve();
    await flushAuthFlow();

    expect(auth.getStatus().signedIn).toBe(false);
    expect(stored).toBeNull();
    expect(profile).toBeNull();
    expect(saveProfile).not.toHaveBeenCalled();
    expect(changes).toHaveLength(1);
  });

  it("emits signed-in status even when persistence fails after device authorization", async () => {
    const saveProfile = vi.fn(async () => {
      throw new Error("profile save failed");
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
      return jsonResponse({
        accessToken: "token-1",
        expiresAt: 10_000 + HOUR_MS,
        userId: "user-1",
        handle: "neo",
        displayName: "Thomas Anderson",
      });
    });
    const { auth, store, changes } = makeService({ now: 10_000, fetchFn, saveProfile });
    vi.mocked(store.save).mockRejectedValueOnce(new Error("credential save failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await auth.startDeviceFlow();
      await flushAuthFlow();

      expect(auth.getStatus()).toEqual({
        signedIn: true,
        handle: "neo",
        displayName: "Thomas Anderson",
        runtimeSlot: "primary",
        platformHost: "https://app.matrix-os.com",
      });
      expect(auth.poll()).toEqual({ status: "authorized", profile: { handle: "neo", userId: "user-1" } });
      expect(changes.at(-1)).toMatchObject({
        signedIn: true,
        handle: "neo",
        displayName: "Thomas Anderson",
      });
      expect(console.warn).toHaveBeenCalledWith("[auth] failed to persist credential:", "credential save failed");
      expect(console.warn).toHaveBeenCalledWith("[auth] failed to persist profile:", "profile save failed");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("AuthService expireSession", () => {
  it("clears the credential, keeps the profile, and emits a signed-out change", async () => {
    const { auth, store, changes, getProfile } = makeService({
      credential: VALID,
      profile: PROFILE,
      now: 10_000,
    });
    await auth.init();
    await auth.expireSession();

    expect(auth.getToken()).toBeNull();
    expect(auth.getStatus().signedIn).toBe(false);
    expect(store.clear).toHaveBeenCalledOnce();
    expect(getProfile()).not.toBeNull();
    expect(auth.getStatus().platformHost).toBe("https://app.matrix-os.com");
    expect(changes.at(-1)).toMatchObject({ signedIn: false });
  });

  it("logs credential cleanup failures without re-throwing after expiry", async () => {
    const { auth, store, changes } = makeService({
      credential: VALID,
      profile: PROFILE,
      now: 10_000,
    });
    const cleanupError = new Error("credential clear failed");
    vi.mocked(store.clear).mockRejectedValueOnce(cleanupError);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await auth.init();

      await expect(auth.expireSession()).resolves.toBeUndefined();

      expect(auth.getStatus().signedIn).toBe(false);
      expect(changes.at(-1)).toMatchObject({
        signedIn: false,
        platformHost: "https://app.matrix-os.com",
      });
      expect(warn).toHaveBeenCalledWith("[auth] failed to clear expired credential:", "credential clear failed");
    } finally {
      warn.mockRestore();
    }
  });

  it("is a no-op when there is no active credential", async () => {
    const { auth, store, changes } = makeService({ credential: null, profile: PROFILE, now: 10_000 });
    await auth.init();
    await auth.expireSession();
    expect(store.clear).not.toHaveBeenCalled();
    expect(changes).toHaveLength(0);
  });

  it("emits signed-out status before persistent sign-out cleanup can fail", async () => {
    const { auth, store, changes } = makeService({
      credential: VALID,
      profile: PROFILE,
      now: 10_000,
    });
    const cleanupError = new Error("credential clear failed");
    vi.mocked(store.clear).mockRejectedValueOnce(cleanupError);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await auth.init();

      await expect(auth.signOut()).rejects.toThrow(cleanupError);

      expect(auth.getStatus().signedIn).toBe(false);
      expect(changes.at(-1)).toMatchObject({
        signedIn: false,
        runtimeSlot: "primary",
        platformHost: "https://app.matrix-os.com",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("does not start polling when sign-out races an in-flight device-code request", async () => {
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
    const { auth, getProfile, peekCredential, store } = makeService({ now: 10_000, fetchFn });

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
    expect(peekCredential()).toBeNull();
    expect(getProfile()).toBeNull();
    expect(store.save).not.toHaveBeenCalled();
  });
});
