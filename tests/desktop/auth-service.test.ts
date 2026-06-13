import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService, type AuthStatus, type ConnectionProfile } from "@desktop/main/auth/auth-service";
import type { CredentialStore, StoredCredential } from "@desktop/main/auth/credential-store";

const HOUR_MS = 3_600_000;

function makeCredentialStore(initial: StoredCredential | null = null) {
  let stored = initial;
  const store: CredentialStore = {
    save: vi.fn(async (c: StoredCredential) => {
      stored = c;
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
  now: number;
}) {
  const { store } = makeCredentialStore(opts.credential ?? null);
  let profile = opts.profile ?? null;
  const changes: AuthStatus[] = [];
  const auth = new AuthService({
    credentialStore: store,
    platformHost: "https://app.matrix-os.com",
    now: () => opts.now,
    loadProfile: async () => profile,
    saveProfile: async (p) => {
      profile = p;
    },
    clearProfile: async () => {
      profile = null;
    },
    onAuthChanged: (status) => changes.push(status),
  });
  return { auth, store, changes, getProfile: () => profile };
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

  it("treats an expired credential as signed-out and withholds the token", async () => {
    const { auth } = makeService({ credential: { ...VALID, expiresAt: 9_000 }, profile: PROFILE, now: 10_000 });
    await auth.init();
    expect(auth.getStatus().signedIn).toBe(false);
    expect(auth.getToken()).toBeNull();
  });

  it("withholds the token within the refresh skew window before exact expiry", async () => {
    // expiresAt is 5s in the future, inside the 30s skew → treat as expired.
    const { auth } = makeService({ credential: { ...VALID, expiresAt: 15_000 }, profile: PROFILE, now: 10_000 });
    await auth.init();
    expect(auth.getToken()).toBeNull();
    expect(auth.getStatus().signedIn).toBe(false);
  });
});

describe("AuthService expireSession", () => {
  it("clears the credential, keeps the profile, and emits a signed-out change", async () => {
    const { auth, store, changes, getProfile } = makeService({ credential: VALID, profile: PROFILE, now: 10_000 });
    await auth.init();
    await auth.expireSession();

    expect(auth.getToken()).toBeNull();
    expect(auth.getStatus().signedIn).toBe(false);
    expect(store.clear).toHaveBeenCalledOnce();
    // Profile is retained so platformHost/runtime survive for a one-click re-auth.
    expect(getProfile()).not.toBeNull();
    expect(auth.getStatus().platformHost).toBe("https://app.matrix-os.com");
    expect(changes.at(-1)).toMatchObject({ signedIn: false });
  });

  it("is a no-op when there is no active credential", async () => {
    const { auth, store, changes } = makeService({ credential: null, profile: PROFILE, now: 10_000 });
    await auth.init();
    await auth.expireSession();
    expect(store.clear).not.toHaveBeenCalled();
    expect(changes).toHaveLength(0);
  });
});
