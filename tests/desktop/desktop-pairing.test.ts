import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi, afterEach } from "vitest";
import type { AuthStatus } from "@desktop/main/auth/auth-service";
import { createDesktopPairing } from "@desktop/main/desktop-pairing";

const prompt = vi.hoisted(() => vi.fn());
vi.mock("@desktop/main/mac-activity/dialog", () => ({ showMacActivityDialog: prompt }));

const machineId = "2fef49db-4468-47b1-a35e-c70d149a7aaf";
const origin = "https://matrix.test";
const ownerId = "user_owner";
const dirs: string[] = [];

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: vi.fn((text: string) => Buffer.from(text).reverse()),
  decryptString: (blob: Buffer) => Buffer.from(blob).reverse().toString("utf8"),
};

afterEach(async () => {
  vi.clearAllMocks();
  prompt.mockReset();
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
  const create = () => createDesktopPairing(deps);
  return { authStatus, deps, state, fetchFn, create, userData };
}

it("persists pair identity across a client restart and disconnects only after explicit consent", async () => {
  const { create, state, fetchFn, userData } = await setup();
  prompt.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 0 });
  await create().open();
  expect(state.revision).toBe(1);
  expect(state.deviceId).toMatch(/^[a-f0-9]{64}$/);
  const lastId = state.deviceId;
  expect(prompt.mock.calls[0]?.[1]).toMatchObject({ buttons: ["Cancel", "Pair This Mac"], defaultId: 0, cancelId: 0 });
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
  expect(prompt.mock.calls[0]?.[1]).toMatchObject({ buttons: ["Cancel", "Disconnect This Mac"], defaultId: 0, cancelId: 0 });
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
  for (const auth of [mismatchedAuth, insecureAuth, otherSlotAuth]) await createDesktopPairing({ ...deps, auth }).open();
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
