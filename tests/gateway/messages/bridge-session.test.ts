import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgePlatformError, type MessagingBridgePlatformClient } from "../../../packages/gateway/src/messages/bridge-platform-client.js";
import { MatrixUnauthorizedError } from "../../../packages/gateway/src/messages/bridge-matrix-client.js";
import {
  BridgeSessionUnavailableError,
  bridgeSessionPath,
  createBridgeSessionProvider,
  createFileBridgeSessionStore,
} from "../../../packages/gateway/src/messages/bridge-session.js";
import { createFileBlobRoutes } from "../../../packages/gateway/src/file-blob-routes.js";

const ownerId = "user_a";
const sessionA = {
  homeserverUrl: "https://bridge.example.test",
  userId: "@mx_owner:bridge.example.test",
  accessToken: "syt_first_secret_token_value",
  deviceId: "MATRIXOSGW",
  networks: ["whatsapp" as const],
};
const sessionB = { ...sessionA, accessToken: "syt_second_secret_token_value" };

function platform(createSession: MessagingBridgePlatformClient["createSession"]): MessagingBridgePlatformClient {
  return {
    createSession,
    listLoginFlows: vi.fn(),
    startLogin: vi.fn(),
    submitLoginStep: vi.fn(),
    cancelLogin: vi.fn(async () => {}),
    listLogins: vi.fn(),
    logout: vi.fn(),
  };
}

describe("bridge session store and provider", () => {
  let root: string;
  let home: string;
  let logged: string[];

  beforeEach(async () => {
    // The secret store sits next to the home, so the home gets its own parent.
    root = await mkdtemp(join(tmpdir(), "bridge-session-"));
    home = join(root, "home");
    await mkdir(home);
    logged = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("persists the session owner-scoped with mode 0600", async () => {
    const store = createFileBridgeSessionStore({ homePath: home });
    await store.write(ownerId, sessionA);

    const path = join(root, ".matrix-private/home/messaging-bridge-session.json");
    expect(bridgeSessionPath({ homePath: home })).toBe(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, ".matrix-private/home"))).mode & 0o777).toBe(0o700);
    await expect(store.read(ownerId)).resolves.toEqual(sessionA);
    await expect(store.read("user_b")).resolves.toBeNull();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1, ownerId });
  });

  it("refuses a session file that other users can read", async () => {
    const store = createFileBridgeSessionStore({ homePath: home });
    await store.write(ownerId, sessionA);
    await chmod(bridgeSessionPath({ homePath: home }), 0o644);
    await expect(store.read(ownerId)).resolves.toBeNull();
  });

  it("keeps the access token out of the owner home, so the files routes cannot serve it", async () => {
    const store = createFileBridgeSessionStore({ homePath: home });
    await store.write(ownerId, sessionA);

    async function filesUnder(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const nested = await Promise.all(entries.map((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? filesUnder(path) : Promise.resolve([path]);
      }));
      return nested.flat();
    }
    for (const file of await filesUnder(home)) {
      expect(await readFile(file, "utf8"), file).not.toContain(sessionA.accessToken);
    }
    const files = createFileBlobRoutes({ homePath: home });
    for (const path of ["system/messaging-bridge/session.json", "../.matrix-private/home/messaging-bridge-session.json"]) {
      const response = await files.request(`/blob?path=${encodeURIComponent(path)}`);
      expect(response.status, path).not.toBe(200);
      expect(await response.text()).not.toContain(sessionA.accessToken);
    }
    expect(() => bridgeSessionPath({ homePath: home, privateRootPath: join(home, "system") })).toThrow();
  });

  it("mints a session once, then serves it from the store", async () => {
    const createSession = vi.fn(async () => sessionA);
    const store = createFileBridgeSessionStore({ homePath: home });
    const provider = createBridgeSessionProvider({ ownerId, store, platform: platform(createSession) });

    await expect(provider.current()).resolves.toEqual(sessionA);
    await expect(provider.current()).resolves.toEqual(sessionA);
    const restarted = createBridgeSessionProvider({ ownerId, store, platform: platform(createSession) });
    await expect(restarted.current()).resolves.toEqual(sessionA);
    expect(createSession).toHaveBeenCalledOnce();
    await expect(provider.stored()).resolves.toEqual(sessionA);
  });

  it("requests a new session exactly once after a 401, then reports unavailable", async () => {
    const createSession = vi.fn(async () => sessionB);
    const store = createFileBridgeSessionStore({ homePath: home });
    await store.write(ownerId, sessionA);
    const provider = createBridgeSessionProvider({ ownerId, store, platform: platform(createSession) });

    const seen: string[] = [];
    await expect(provider.withSession(async (session) => {
      seen.push(session.accessToken);
      if (session.accessToken === sessionA.accessToken) throw new MatrixUnauthorizedError();
      return "ok";
    })).resolves.toBe("ok");
    expect(seen).toEqual([sessionA.accessToken, sessionB.accessToken]);
    await expect(store.read(ownerId)).resolves.toEqual(sessionB);
    expect(provider.tokenRejected()).toBe(false);

    const rejecting = vi.fn(async () => {
      throw new MatrixUnauthorizedError();
    });
    await expect(provider.withSession(rejecting)).rejects.toBeInstanceOf(BridgeSessionUnavailableError);
    expect(rejecting).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(provider.tokenRejected()).toBe(true);
    expect(logged.join("\n")).not.toMatch(/syt_/);
  });

  it("propagates platform refusals such as not_enabled", async () => {
    const createSession = vi.fn(async () => {
      throw new BridgePlatformError("not_enabled");
    });
    const provider = createBridgeSessionProvider({ ownerId, store: createFileBridgeSessionStore({ homePath: home }), platform: platform(createSession) });
    await expect(provider.current()).rejects.toMatchObject({ code: "not_enabled" });
  });
});
