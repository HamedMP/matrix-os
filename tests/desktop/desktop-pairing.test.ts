import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthStatus } from "@desktop/main/auth/auth-service";
import { createDesktopPairing } from "@desktop/main/desktop-pairing";

const prompt = vi.hoisted(() => vi.fn());
vi.mock("@desktop/main/desktop-pairing/dialog", () => ({ showDesktopLinkDialog: prompt }));

const machineId = "2fef49db-4468-47b1-a35e-c70d149a7aaf";
const origin = "https://matrix.test";
const ownerId = "user_owner";
const dirs: string[] = [];
const pairings: ReturnType<typeof createDesktopPairing>[] = [];

function createPairing(options: Parameters<typeof createDesktopPairing>[0]) {
  // These cases are the macOS dialogs; other platforms are covered below.
  const pairing = createDesktopPairing({ platform: "darwin", desktopLinkAvailable: true, ...options });
  pairings.push(pairing);
  return pairing;
}

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: vi.fn((text: string) => Buffer.from(text).reverse()),
  decryptString: (blob: Buffer) => Buffer.from(blob).reverse().toString("utf8"),
};

afterEach(async () => {
  vi.clearAllMocks();
  prompt.mockReset();
  for (const pairing of pairings.splice(0)) pairing.dispose();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const userData = await mkdtemp(join(tmpdir(), "matrix-test-pair-"));
  dirs.push(userData);

  const authStatus = vi.fn<() => AuthStatus>(() => ({
    signedIn: true, userId: ownerId, platformHost: origin, handle: "primary",
    runtimeSlot: "primary", authGeneration: 0,
  }));
  const auth = { getStatus: authStatus, getToken: () => "test-bearer", getGatewayOrigin: () => origin };
  const state = { machineId, revision: 0, deviceId: null as string | null };
  const nonce = randomBytes(32).toString("base64url");
  let challengedDevice: string | undefined;
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input.toString());
    expect(url.origin).toBe(origin);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-bearer");
    expect(init?.redirect).toBe("error");
    if (url.pathname === "/api/desktop-pairing" && (!init?.method || init.method === "GET")) {
      return Response.json(state);
    }
    if (url.pathname === "/api/desktop-pairing/challenge" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { deviceId: string; revision: number };
      expect(body.revision).toBe(state.revision);
      challengedDevice = body.deviceId;
      return Response.json({ machineId, ...body, nonce, expiresAt: Date.now() + 60_000 });
    }
    if (url.pathname === "/api/desktop-pairing/pair" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { nonce: string; publicKey: string; signature: string };
      const publicBytes = Buffer.from(body.publicKey, "base64url");
      const publicKey = createPublicKey({ key: publicBytes, format: "der", type: "spki" });
      const deviceId = createHash("sha256").update(publicBytes).digest("hex");
      expect(deviceId).toBe(challengedDevice);
      expect(body.nonce).toBe(nonce);
      const proof = JSON.stringify(["matrix-desktop-pairing-v1", ownerId, machineId, deviceId, state.revision, nonce]);
      expect(verify(null, Buffer.from(proof), publicKey, Buffer.from(body.signature, "base64url"))).toBe(true);
      state.deviceId = deviceId;
      state.revision++;
      return Response.json(state);
    }
    if (url.pathname === `/api/desktop-pairing/${state.deviceId}` && init?.method === "DELETE") {
      expect(headers.get("If-Match")).toBe(`"desktop-pairing-${machineId}-${state.deviceId}-${state.revision}"`);
      expect(JSON.parse(String(init.body))).toEqual({ revision: state.revision });
      state.deviceId = null;
      state.revision++;
      return Response.json(state);
    }
    throw new Error(`Unexpected pairing route: ${url.pathname}`);
  });

  const deps = { auth, safeStorage, window: () => null, userData, fetchFn };
  const create = () => createPairing(deps);
  const enroll = async () => {
    const pairing = create();
    prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
    await pairing.open();
    expect(state.revision).toBe(1);
    prompt.mockClear();
    fetchFn.mockClear();
    return pairing;
  };
  return { authStatus, deps, state, fetchFn, create, userData, enroll };
}

it.each(["device", "desktop-link-full-access"])("sweeps stale %s files while idle, preserves links and grace, and stops on disposal", async (recordType) => {
  const { create, userData } = await setup();
  const directory = join(userData, "desktop-pairing");
  const keyName = `${recordType}-${"a".repeat(64)}.bin`;
  const temporaryName = () => `${keyName}.${randomUUID()}.tmp`;
  const now = Date.now();
  const old = new Date(now - 2 * 60 * 60_000);
  const recent = new Date(now - 58 * 60_000 - 30_000);
  const staleName = temporaryName();
  const recentName = temporaryName();
  const linkName = temporaryName();
  const linkTarget = join(userData, "symlink-target");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(linkTarget, "keep");
  await symlink(linkTarget, join(directory, linkName));
  async function writeKeyFile(name: string, date: Date) {
    const path = join(directory, name);
    await writeFile(path, "encrypted", { mode: 0o600 });
    await utimes(path, date, date);
  }
  await writeKeyFile(keyName, old);
  await writeKeyFile(staleName, old);
  await writeKeyFile(recentName, recent);

  vi.useFakeTimers();
  vi.setSystemTime(now);
  const pairing = create();
  try {
    pairing.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => expect(await readdir(directory)).not.toContain(staleName));
    expect(await readdir(directory)).toContain(recentName);
    expect(await readdir(directory)).toContain(keyName);
    expect((await lstat(join(directory, linkName))).isSymbolicLink()).toBe(true);
    expect(await readFile(linkTarget, "utf8")).toBe("keep");

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => expect(await readdir(directory)).not.toContain(recentName));

    pairing.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await writeKeyFile(staleName, old);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await readdir(directory)).toContain(staleName);
  } finally {
    pairing.dispose();
    vi.useRealTimers();
  }
});

it("persists pair identity across a client restart and disconnects only after explicit consent", async () => {
  const { create, state, fetchFn, userData } = await setup();
  prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
  await create().open();
  expect(state.revision).toBe(1);
  expect(state.deviceId).toMatch(/^[a-f0-9]{64}$/);
  const lastId = state.deviceId;
  expect(prompt.mock.calls[0]?.[1]).toMatchObject({
    buttons: ["Cancel", "Pair This Mac"], defaultId: 0, cancelId: 0,
  });
  expect(safeStorage.encryptString).toHaveBeenCalledTimes(1);
  const dir = join(userData, "desktop-pairing");
  const [file, ...extra] = await readdir(dir);
  expect(extra).toEqual([]);
  const path = join(dir, file!);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect((await readFile(path)).toString("utf8")).not.toContain(safeStorage.encryptString.mock.calls[0]?.[0]);

  prompt.mockClear();
  prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
  await create().open();
  expect(prompt.mock.calls[0]?.[1]).toMatchObject({
    buttons: ["Done", "Disconnect This Mac", "Allow Desktop Link Full Access"], defaultId: 0, cancelId: 0,
  });
  expect(state).toEqual({ machineId, revision: 2, deviceId: null });
  expect(fetchFn.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);

  prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
  await create().open();
  expect(state).toEqual({ machineId, revision: 3, deviceId: lastId });
  expect(safeStorage.encryptString).toHaveBeenCalledTimes(1);
});

it("concurrently opens only one dialog and cancels the operation explicitly", async () => {
  const { create, fetchFn, userData } = await setup();
  let resolvePrompt!: (answer: { response: number }) => void;
  const awaitingConsent = new Promise<{ response: number }>(resolve => { resolvePrompt = resolve; });
  prompt.mockReturnValueOnce(awaitingConsent);
  const pairing = create();
  const pending = pairing.open();
  await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  await pairing.open();
  expect(prompt).toHaveBeenCalledTimes(1);
  pairing.cancel();
  expect(prompt.mock.calls[0]?.[1].signal.aborted).toBe(true);
  resolvePrompt({ response: 1 });
  await pending;
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(await readdir(userData)).toEqual([]);
});

it("checks the active account again after consent even if no cancellation callback ran", async () => {
  const { create, authStatus, fetchFn, userData } = await setup();
  prompt.mockImplementationOnce(async () => {
    authStatus.mockReturnValue({ signedIn: true, userId: "other-owner", platformHost: origin, handle: "primary",
      runtimeSlot: "primary", authGeneration: 1 });
    return { response: 1 };
  }).mockResolvedValueOnce({ response: 0 });
  await create().open();
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(safeStorage.encryptString).not.toHaveBeenCalled();
  expect(await readdir(userData)).toEqual([]);
});

it("leaves an unused Mac unpaired when the user cancels", async () => {
  const { create, fetchFn, userData } = await setup();
  prompt.mockResolvedValueOnce({ response: 0 });
  await create().open();
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(await readdir(userData)).toEqual([]);
});

it("does not offer to replace another Mac", async () => {
  const { create, state, fetchFn, userData } = await setup();
  state.deviceId = "a".repeat(64);
  state.revision = 7;
  prompt.mockResolvedValueOnce({ response: 0 });
  await create().open();
  expect(prompt).toHaveBeenCalledWith(null, expect.objectContaining({
    message: "Another Mac is paired to this Computer.", buttons: ["OK"],
  }));
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(await readdir(userData)).toEqual([]);
});

it("reconciles a lost pair reply without sending another mutation", async () => {
  const { create, state, fetchFn } = await setup();
  const transport = fetchFn.getMockImplementation()!;
  fetchFn.mockImplementation(async (...args) => {
    const response = await transport(...args);
    if (args[0].toString().endsWith("/pair")) {
      await response.body?.cancel();
      throw new Error("Disconnected after commit");
    }
    return response;
  });
  prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
  await create().open();
  expect(state.revision).toBe(1);
  expect(fetchFn.mock.calls.filter(([url]) => url.toString().endsWith("/pair"))).toHaveLength(1);
  expect(fetchFn.mock.calls.filter(([url]) => url.toString().endsWith("/desktop-pairing"))).toHaveLength(2);
  expect(prompt.mock.calls.at(-1)?.[1].message).toBe("This Mac is paired.");
});

it("reads an ambiguous disconnect after reconnection without repeating the write", async () => {
  const { create, state, fetchFn } = await setup();
  prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
  await create().open();
  fetchFn.mockClear();
  const transport = fetchFn.getMockImplementation()!;
  fetchFn.mockImplementation(async (...args) => {
    const response = await transport(...args);
    if (args[1]?.method === "DELETE") {
      await response.body?.cancel();
      throw new Error("Disconnected after commit");
    }
    return response;
  });
  prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
  await create().open();
  expect(state.revision).toBe(2);
  expect(fetchFn.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "DELETE", "GET"]);
  expect(prompt.mock.calls.at(-1)?.[1].message).toBe("This Mac is disconnected.");
});

it("cannot send the Matrix credential outside the selected primary HTTPS origin", async () => {
  const { deps, fetchFn } = await setup();
  const mismatchedAuth = { ...deps.auth, getGatewayOrigin: () => "https://other.matrix.test" };
  const insecureAuth = { ...deps.auth, getGatewayOrigin: () => "http://matrix.test" };
  const otherSlotAuth = { ...deps.auth, getStatus: () => ({ ...deps.auth.getStatus(), runtimeSlot: "preview" }) };
  prompt.mockResolvedValue({ response: 0 });
  for (const auth of [mismatchedAuth, insecureAuth, otherSlotAuth]) await createPairing({ ...deps, auth }).open();
  expect(fetchFn).not.toHaveBeenCalled();
  expect(prompt).toHaveBeenCalledTimes(3);
});

it("fails closed when the Computer changed before the signed proof", async () => {
  const { create, fetchFn, state } = await setup();
  const transport = fetchFn.getMockImplementation()!;
  fetchFn.mockImplementation(async (...args) => {
    const response = await transport(...args);
    if (!args[0].toString().endsWith("/challenge")) return response;
    const challenge = await response.json() as object;
    return Response.json({ ...challenge, machineId: "9797ec1f-666c-4a68-9505-918060fbecc3" });
  });
  prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
  await create().open();
  expect(state.revision).toBe(0);
  expect(fetchFn.mock.calls.some(([url]) => url.toString().endsWith("/pair"))).toBe(false);
});

it("refuses symlinked key files and leaves their targets unchanged", async () => {
  const { create, fetchFn, userData } = await setup();
  prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
  await create().open();
  const dir = join(userData, "desktop-pairing");
  const [file] = await readdir(dir);
  const path = join(dir, file!);
  const target = join(userData, "another-file");
  await writeFile(target, "target", { mode: 0o600 });
  await rm(path);
  await symlink(target, path);
  fetchFn.mockClear();
  prompt.mockResolvedValueOnce({ response: 0 });
  await create().open();
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  expect(await readFile(target, "utf8")).toBe("target");
});

describe("pairing for the desktop link", () => {
  it("pairs a Windows PC through its device dialog", async () => {
    const { deps, state } = await setup();
    const pairing = createPairing({ ...deps, platform: "win32" });
    prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
    await pairing.open();
    expect(prompt.mock.calls[0]?.[1]).toMatchObject({ message: "Pair this PC?", buttons: ["Cancel", "Pair This PC"] });
    expect(prompt.mock.calls.at(-1)?.[1].message).toBe("This PC is paired.");
    expect(state.revision).toBe(1);
    prompt.mockResolvedValueOnce({ response: 0 });
    await pairing.open();
    expect(prompt.mock.calls.at(-1)?.[1]).toMatchObject({ message: "This PC is paired.", buttons: ["Done", "Disconnect This PC", "Allow Desktop Link Full Access"] });
  });

  it("gives the link this device's key only while it is the paired device at the current revision", async () => {
    const { deps, state } = await setup();
    const pairing = createPairing({ ...deps, platform: "linux" });
    expect(await pairing.linkIdentity(AbortSignal.timeout(5_000))).toBeNull();
    prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
    await pairing.open();
    const identity = await pairing.linkIdentity(AbortSignal.timeout(5_000));
    expect(identity).toMatchObject({ origin, ownerId, machineId, deviceId: state.deviceId, revision: 1 });
    expect(identity?.privateKey.asymmetricKeyType).toBe("ed25519");
    // Paired elsewhere (another device's id at a newer revision): no identity here.
    state.deviceId = "f".repeat(64);
    state.revision = 3;
    expect(await pairing.linkIdentity(AbortSignal.timeout(5_000))).toBeNull();
  });

  // Fault detected: a desktop link opened by an earlier pairing kept running
  // through Disconnect until the revocation request came back.
  it("tells the link as pairing commits, and before the disconnect request is sent", async () => {
    const { deps, fetchFn } = await setup();
    const order: string[] = [];
    const pairing = createPairing({
      ...deps, platform: "linux", onPaired: () => order.push("paired"), onDisconnecting: () => order.push("disconnecting"),
    });
    const transport = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation(async (input, init) => {
      order.push(`${init?.method ?? "GET"} ${new URL(input.toString()).pathname}`);
      return transport(input, init);
    });
    prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
    await pairing.open();
    expect(order.at(-1)).toBe("paired");
    order.length = 0;
    prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
    await pairing.open();
    expect(order.indexOf("disconnecting")).toBeGreaterThan(-1);
    expect(order.indexOf("disconnecting")).toBeLessThan(order.findIndex((entry) => entry.startsWith("DELETE")));
    expect(await pairing.linkIdentity(AbortSignal.timeout(5_000))).toBeNull();
  });
});

describe("desktop link Full Access (spec 2716, D2)", () => {
  it("is allowed and revoked in the pairing dialog, and holds only for the pairing it was given under", async () => {
    const { deps, state } = await setup();
    const pairing = createPairing({ ...deps, platform: "win32" });
    prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
    await pairing.open();
    const identity = (await pairing.linkIdentity(AbortSignal.timeout(5_000)))!;
    expect(await pairing.linkFullAccess(identity)).toBe(false);
    // Paired dialog: Done, Disconnect, Allow Desktop Link Full Access.
    prompt.mockResolvedValueOnce({ response: 2 }).mockResolvedValueOnce({ response: 0 });
    await pairing.open();
    expect(prompt.mock.calls.at(-2)?.[1].buttons).toEqual(["Done", "Disconnect This PC", "Allow Desktop Link Full Access"]);
    expect(prompt.mock.calls.at(-1)?.[1].message).toBe("Desktop Link Full Access is allowed.");
    expect(await pairing.linkFullAccess(identity)).toBe(true);
    // A newer pairing revision never inherits it.
    expect(await pairing.linkFullAccess({ ...identity, revision: identity.revision + 1 })).toBe(false);
    prompt.mockResolvedValueOnce({ response: 2 }).mockResolvedValueOnce({ response: 0 });
    await pairing.open();
    expect(prompt.mock.calls.at(-2)?.[1].buttons).toContain("Revoke Desktop Link Full Access");
    expect(await pairing.linkFullAccess(identity)).toBe(false);
    expect(state.revision).toBe(1);
  });
});

it("reuses a paired Mac and its explicit Desktop Link grant without promoting legacy Chat consent", async () => {
  const { create, enroll, state, userData } = await setup();
  const first = await enroll();
  const identity = (await first.linkIdentity(AbortSignal.timeout(5_000)))!;
  first.dispose();

  const directory = join(userData, "desktop-pairing");
  const scope = createHash("sha256").update(JSON.stringify([ownerId, origin])).digest("hex");
  const legacyGrant = safeStorage.encryptString(JSON.stringify({ ...state, scope, capability: "mac-verification" }));
  await writeFile(join(directory, `chat-full-access-${scope}.bin`), legacyGrant, { mode: 0o600 });
  const restarted = create();
  expect(await restarted.linkIdentity(AbortSignal.timeout(5_000))).toMatchObject({ deviceId: identity.deviceId, revision: 1 });
  expect(await restarted.linkFullAccess(identity)).toBe(false);
  prompt.mockResolvedValueOnce({ response: 0 });
  await restarted.open();
  expect(prompt.mock.calls.at(-1)?.[1].buttons).toEqual(["Done", "Disconnect This Mac", "Allow Desktop Link Full Access"]);

  const linkPath = join(directory, `desktop-link-full-access-${scope}.bin`);
  await writeFile(linkPath, legacyGrant, { mode: 0o600 });
  expect(await restarted.linkFullAccess(identity)).toBe(false);
  const linkGrant = safeStorage.encryptString(JSON.stringify({ ...state, scope, capability: "desktop-link" }));
  await writeFile(linkPath, linkGrant, { mode: 0o600 });
  expect(await restarted.linkFullAccess(identity)).toBe(true);
  expect(await restarted.linkFullAccess({ ...identity, revision: identity.revision + 1 })).toBe(false);
});

it("offers pairing without link permissions when no Desktop Link consumer is installed", async () => {
  const { deps, state } = await setup();
  const pairing = createDesktopPairing(deps);
  pairings.push(pairing);
  prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
  await pairing.open();
  expect(state.deviceId).toMatch(/^[a-f0-9]{64}$/);
  prompt.mockResolvedValueOnce({ response: 0 });
  await pairing.open();
  const dialog = prompt.mock.calls.at(-1)?.[1];
  expect(dialog.buttons).toHaveLength(2);
  expect(dialog.buttons[1]).toMatch(/^Disconnect This /);
  expect(dialog.detail).not.toMatch(/terminal|screenshot|Desktop Link/i);
});
