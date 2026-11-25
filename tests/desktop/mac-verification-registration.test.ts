import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import type { IpcMain } from "electron";
import { desktopPairingActionProofMessage } from "@matrix-os/contracts";
import type { AuthService } from "@desktop/main/auth/auth-service";
import type { ChatElectronPreviewTarget } from "@desktop/shared/chat-electron-preview-ipc";
import { createMacActionPairing } from "@desktop/main/desktop-pairing/action";
import type { createChatElectronPreviewTransport } from "@desktop/main/chat-electron-preview/transport";
import { registerChatElectronPreview } from "@desktop/main/chat-electron-preview/register";

const electron = vi.hoisted(() => ({
  showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["/verified-checkout"] })),
  showMessageBox: vi.fn(),
}));
const execute = vi.hoisted(() => vi.fn(async () => ({ png: Buffer.from("fixture"), testSummary: "5 passed" })));
vi.mock("electron", () => ({ dialog: electron }));
vi.mock("@desktop/main/chat-electron-preview/executor", () => ({ runChatElectronPreview: execute }));
vi.mock("@desktop/main/chat-electron-preview/verification-setup", async (original) => {
  const actual = await original<typeof import("@desktop/main/chat-electron-preview/verification-setup")>();
  return {
    ...actual,
    resolveVerificationSource: vi.fn(async () => ({
      checkout: "/verified-checkout", electronPath: "/pinned/Electron", identity: "verified-local-executable",
    })),
  };
});

const Verification = "verification" as const;
const scope = { chatId: "chat_fixture", projectId: "matrix-os", worktreeId: "wt_00000000000a" };
const verified = { chatId: scope.chatId, runId: "run_fixture", requestKind: Verification };
const actionPairing = () => ({ check: vi.fn(async () => true), close: vi.fn() });

function previewFixture() {
  const deadlines = new Map<string, number>();
  const transport = {
    read: vi.fn(async (target: ChatElectronPreviewTarget) => ({
      ...target, projectId: scope.projectId, worktreeId: scope.worktreeId, scopeKey: "scope",
      baseSha: "a".repeat(40), sourceSha256: "b".repeat(64), label: "APPROVED",
      expiresAt: deadlines.get(target.runId),
    })),
    returnResult: vi.fn(async () => {}),
    isCurrent: vi.fn(() => true),
  };
  const handlers = new Map();
  const ipc = { handle: (channel: string, callback: unknown) => { handlers.set(channel, callback); } } as Pick<IpcMain, "handle">;
  const auth = {
    getToken: () => "test-auth",
    getGatewayOrigin: () => "https://app.matrix-os.com",
    getStatus: () => ({
      signedIn: true, runtimeSlot: "primary", platformHost: "https://app.matrix-os.com",
      userId: "owner_1", handle: "fixture", authGeneration: 1,
    }),
  } as AuthService;
  return {
    ipc,
    auth,
    transport: transport as unknown as ReturnType<typeof createChatElectronPreviewTransport>,
    run: (target: ChatElectronPreviewTarget, fullAccessViewId?: string) => {
      if (!deadlines.has(target.runId)) deadlines.set(target.runId, Date.now() + 60_000);
      return handlers.get("chat:electron-preview-run")("trusted", { ...target, fullAccessViewId });
    },
    select: (selection = scope, viewId = randomUUID(), event = "trusted") => {
      handlers.get("chat:mac-verification-selection")(event, { viewId, scope: selection });
      return viewId;
    },
    clear: (viewId: string) => handlers.get("chat:mac-verification-selection")("trusted", { viewId, scope: null }),
    readAvailable: () => handlers.get("chat:electron-preview-available")("trusted", {}),
  };
}

async function withPreview(
  test: (context: ReturnType<typeof registerChatElectronPreview> & ReturnType<typeof previewFixture> & {
    prompts: string[];
    supervised: ReturnType<typeof vi.fn>;
    fullAccess: ReturnType<typeof vi.fn>;
    distrust(): void;
  }) => Promise<void>,
) {
  const profile = await mkdtemp(join(tmpdir(), "matrix-verification-ipc-"));
  const prompts: string[] = [];
  electron.showMessageBox.mockImplementation(async (_window, { message }) => {
    prompts.push(message);
    return { response: 1 };
  });
  execute.mockClear();
  const fixture = previewFixture();
  const supervised = vi.fn(async () => actionPairing());
  const fullAccess = vi.fn(async () => actionPairing());
  let trusted = true;
  const registered = registerChatElectronPreview(fixture.ipc, {
    auth: fixture.auth, transport: fixture.transport, allowed: false, macVerificationAllowed: true,
    checkout: "/inherited-legacy-checkout", electronPath: "/Applications/Matrix.app",
    userData: profile, acquireActionPairing: supervised, acquireFullAccessPairing: fullAccess,
    window: () => ({ isDestroyed: () => false }) as never,
    isTrustedSender: (event) => trusted && event === "trusted",
  });
  try {
    await test({ ...fixture, ...registered, prompts, supervised, fullAccess, distrust: () => { trusted = false; } });
  } finally {
    await registered.cancel();
    await rm(profile, { recursive: true, force: true });
  }
}

describe("Mac Verification packaged IPC", () => {
  it("uses the currently selected Chat mode with the already-completed run and permits subsequent Full Access runs", async () => {
    await withPreview(async ({ openVerification, run, readAvailable, select, clear, prompts, supervised, fullAccess }) => {
      expect(readAvailable()).toEqual({ available: false, verificationAvailable: false });
      expect(await run(verified)).toEqual({ status: "unavailable" });
      await openVerification?.();
      expect(readAvailable()).toEqual({ available: false, verificationAvailable: true });
      expect(await run({ chatId: verified.chatId, runId: verified.runId })).toEqual({ status: "unavailable" });
      const view = select();
      expect(await run(verified, view)).toEqual({ status: "returned" });
      expect(await run({ ...verified, runId: "run_second" }, view)).toEqual({ status: "returned" });
      expect(prompts).toEqual(["Enable Mac Verification?"]);
      expect(fullAccess).toHaveBeenCalledTimes(2);
      expect(supervised).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({
        checkout: "/verified-checkout", electronPath: "/pinned/Electron", requestKind: Verification,
      }));
      clear(view);
      expect(await run({ ...verified, runId: "run_third" }, view)).toEqual({ status: "unavailable" });
      expect(prompts).toEqual(["Enable Mac Verification?"]);
      expect(await run({ ...verified, runId: "run_third" })).toEqual({ status: "returned" });
      expect(prompts.at(-1)).toBe("Approve one Electron Desktop preview?");
      expect(supervised).toHaveBeenCalledOnce();
    });
  });

  it("keeps the live Full Access selection after the former 15-minute grant window", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await withPreview(async ({ openVerification, run, select, prompts, fullAccess }) => {
        await openVerification?.();
        const view = select();
        expect(await run(verified, view)).toEqual({ status: "returned" });
        clock.mockReturnValue(now + 16 * 60_000);
        expect(await run({ ...verified, runId: "run_later" }, view)).toEqual({ status: "returned" });
        expect(prompts).toEqual(["Enable Mac Verification?"]);
        expect(fullAccess).toHaveBeenCalledTimes(2);
      });
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    { pairingFailures: 1, status: "returned" },
    { pairingFailures: 2, status: "unavailable" },
  ])("returns a Full Access result only after a fresh pairing read ($pairingFailures gateway 502s)", async ({
    pairingFailures, status,
  }) => {
    await withPreview(async ({ auth, openVerification, run, select, fullAccess, supervised, transport }) => {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const publicBytes = publicKey.export({ format: "der", type: "spki" });
      const deviceId = createHash("sha256").update(publicBytes).digest("hex");
      const state = { deviceId, machineId: randomUUID(), revision: 3 };
      const nonce = Buffer.alloc(32, 7).toString("base64url");
      let deliveryReads = 0;
      const pairing = createMacActionPairing({
        auth,
        keys: { load: async () => ({ deviceId, privateKey, publicKey: publicBytes.toString("base64url") }) },
        hasChatFullAccess: async () => true,
        fetchFn: async (input, init) => {
          const { pathname } = new URL(String(input));
          if (pathname === "/api/desktop-pairing/action-challenge") {
            return Response.json({ ...state, nonce, expiresAt: Date.now() + 60_000 });
          }
          if (pathname === "/api/desktop-pairing/verify-action") {
            const body = JSON.parse(String(init?.body));
            const proof = desktopPairingActionProofMessage({ ownerId: "owner_1", ...state, nonce });
            expect(body.nonce).toBe(nonce);
            expect(verify(null, Buffer.from(proof), publicKey, Buffer.from(body.signature, "base64url"))).toBe(true);
            return Response.json(state);
          }
          expect(pathname).toBe("/api/desktop-pairing");
          expect(init?.method).toBe("GET");
          if (execute.mock.calls.length && ++deliveryReads <= pairingFailures) {
            return new Response(null, { status: 502 });
          }
          return Response.json(state);
        },
      });
      fullAccess.mockImplementationOnce(pairing.acquireFullAccess);
      await openVerification?.();
      const view = select();
      expect(await run(verified, view)).toEqual({ status });
      expect(deliveryReads).toBe(2);
      expect(transport.returnResult).toHaveBeenCalledTimes(status === "returned" ? 1 : 0);
      if (status === "returned") {
        expect(transport.returnResult).toHaveBeenCalledWith(
          expect.objectContaining(verified),
          { png: Buffer.from("fixture"), testSummary: "5 passed" },
          expect.any(AbortSignal),
        );
      }
      expect(await run(verified, view)).toEqual({ status: "already-handled" });
      expect(execute).toHaveBeenCalledOnce();
      expect(supervised).not.toHaveBeenCalled();
    });
  });

  it("requires the trusted renderer, matching Chat/worktree, and affirmative pairing consent", async () => {
    await withPreview(async ({ openVerification, run, select, clear, prompts, fullAccess }) => {
      await openVerification?.();
      expect(() => select(scope, randomUUID(), "untrusted")).toThrow("invalid request");
      const wrongView = select({ ...scope, worktreeId: "wt_00000000000b" });
      expect(await run(verified, wrongView)).toEqual({ status: "unavailable" });
      expect(fullAccess).not.toHaveBeenCalled();
      const view = select();
      fullAccess.mockResolvedValueOnce(null);
      expect(await run(verified, view)).toEqual({ status: "unavailable" });
      expect(prompts).toEqual(["Enable Mac Verification?"]);
      clear(view);
      expect(await run(verified)).toEqual({ status: "returned" });
      expect(prompts).toEqual(["Enable Mac Verification?", "Approve one Electron Desktop preview?"]);
    });
  });

  it.each(["superseded Chat", "closed renderer", "lost sender", "downgraded mode", "Stop"])(
    "cancels admission during asynchronous pairing after %s", async (reason) => {
      await withPreview(async (context) => {
        const { openVerification, run, transport, select, clear, fullAccess, supervised } = context;
        await openVerification?.();
        const view = select();
        const proof = Promise.withResolvers<ReturnType<typeof actionPairing>>();
        fullAccess.mockReturnValueOnce(proof.promise);
        const result = run(verified, view);
        await vi.waitFor(() => expect(fullAccess).toHaveBeenCalledOnce());
        let stopped: Promise<void> | undefined;
        let replacement: string | undefined;
        if (reason === "superseded Chat") {
          replacement = select({ ...scope, chatId: "chat_different" });
          clear(view);
        } else if (reason === "closed renderer") context.clearFullAccessSelection();
        else if (reason === "lost sender") context.distrust();
        else if (reason === "downgraded mode") clear(view);
        else stopped = context.cancel("stopped");
        const lease = actionPairing();
        proof.resolve(lease);
        expect(await result).toEqual({ status: "unavailable" });
        await stopped;
        expect(lease.close).toHaveBeenCalledOnce();
        expect(execute).not.toHaveBeenCalled();
        expect(supervised).not.toHaveBeenCalled();
        expect(transport.returnResult).not.toHaveBeenCalled();
        if (reason === "superseded Chat") {
          expect(await run({ ...verified, chatId: "chat_different", runId: "run_new" }, replacement))
            .toEqual({ status: "returned" });
          expect(fullAccess).toHaveBeenCalledTimes(2);
          expect(supervised).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each(["revoked pairing", "switched Chat", "lost sender", "Stop"])(
    "withholds the result after %s during the build", async (reason) => {
      await withPreview(async (context) => {
        const { openVerification, run, transport, select, fullAccess } = context;
        await openVerification?.();
        const view = select();
        const lease = actionPairing();
        fullAccess.mockResolvedValueOnce(lease);
        const build = Promise.withResolvers<{ png: Buffer; testSummary: string }>();
        execute.mockReturnValueOnce(build.promise);
        const result = run(verified, view);
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
        let stopped: Promise<void> | undefined;
        if (reason === "revoked pairing") lease.check.mockResolvedValue(false);
        else if (reason === "switched Chat") select({ ...scope, chatId: "chat_different" });
        else if (reason === "lost sender") context.distrust();
        else stopped = context.cancel("stopped");
        build.resolve({ png: Buffer.from("test"), testSummary: "5 passed" });
        expect(await result).toEqual({ status: "unavailable" });
        await stopped;
        expect(transport.returnResult).not.toHaveBeenCalled();
        expect(lease.close).toHaveBeenCalledOnce();
      });
    },
  );
});
