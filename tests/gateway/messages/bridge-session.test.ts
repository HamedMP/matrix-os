import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgePlatformError, type MessagingBridgePlatformClient } from "../../../packages/gateway/src/messages/bridge-platform-client.js";
import { MatrixUnauthorizedError } from "../../../packages/gateway/src/messages/bridge-matrix-client.js";
import {
  BridgeSessionUnavailableError,
  createBridgeSessionProvider,
  createFileBridgeSessionStore,
} from "../../../packages/gateway/src/messages/bridge-session.js";

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
    listLogins: vi.fn(),
    logout: vi.fn(),
  };
}

describe("bridge session store and provider", () => {
  let home: string;
  let logged: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "bridge-session-"));
    logged = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  it("persists the session owner-scoped with mode 0600", async () => {
    const store = createFileBridgeSessionStore({ homePath: home });
    await store.write(ownerId, sessionA);

    const path = join(home, "system/messaging-bridge/session.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "system/messaging-bridge"))).mode & 0o777).toBe(0o700);
    await expect(store.read(ownerId)).resolves.toEqual(sessionA);
    await expect(store.read("user_b")).resolves.toBeNull();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1, ownerId });
  });

  it("refuses a session file that other users can read", async () => {
    const store = createFileBridgeSessionStore({ homePath: home });
    await store.write(ownerId, sessionA);
    await chmod(join(home, "system/messaging-bridge/session.json"), 0o644);
    await expect(store.read(ownerId)).resolves.toBeNull();
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
