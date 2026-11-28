import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import type { AuthService } from "@desktop/main/auth/auth-service";
import type { ChatElectronPreviewTarget } from "@desktop/shared/chat-electron-preview-ipc";
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

function previewFixture() {
  const expiresAt = Date.now() + 60_000;
  const transport = {
    read: vi.fn(async (target: ChatElectronPreviewTarget) => ({
      ...target, projectId: "matrix-os", worktreeId: "wt_fixture", scopeKey: "scope",
      baseSha: "a".repeat(40), sourceSha256: "b".repeat(64), label: "APPROVED",
      expiresAt,
    })),
    returnResult: vi.fn(async () => {}),
    isCurrent: vi.fn(() => true),
  };
  const handlers = new Map();
  const ipc = { handle: (channel: string, callback: unknown) => { handlers.set(channel, callback); } } as Pick<IpcMain, "handle">;
  const auth = { getStatus: () => ({
    signedIn: true, runtimeSlot: "primary", platformHost: "https://app.matrix-os.com",
    userId: "owner_1", handle: "fixture", authGeneration: 1,
  }) } as AuthService;
  return {
    ipc,
    auth,
    transport: transport as unknown as ReturnType<typeof createChatElectronPreviewTransport>,
    run: (target: ChatElectronPreviewTarget) => handlers.get("chat:electron-preview-run")("trusted", target),
    readAvailable: () => handlers.get("chat:electron-preview-available")("trusted", {}),
  };
}

describe("Mac Verification packaged IPC", () => {
  it("opens only markerless verification, bypasses approval only after the native grant and restores approval after Stop", async () => {
    const profile = await mkdtemp(join(tmpdir(), "matrix-verification-ipc-"));
    const responses = [1, 1, 2, 1, 1];
    const prompts: string[] = [];
    electron.showMessageBox.mockImplementation(async (_window, { message }) => {
      prompts.push(message);
      return { response: responses.shift() ?? 0 };
    });

    const { ipc, auth, transport, run, readAvailable } = previewFixture();
    const pairing = vi.fn(async () => ({ check: async () => true, close() {} }));
    const verified = { chatId: "chat_fixture", runId: "run_fixture", requestKind: Verification };

    try {
      const registered = registerChatElectronPreview(ipc, {
        auth, transport, allowed: false, macVerificationAllowed: true,
        checkout: "/inherited-legacy-checkout", electronPath: "/Applications/Matrix.app",
        userData: profile, acquireActionPairing: pairing,
        window: () => ({ isDestroyed: () => false }) as never,
        isTrustedSender: (event) => event === "trusted",
      });
      expect(readAvailable()).toEqual({ available: false, verificationAvailable: false });
      expect(await run(verified)).toEqual({ status: "unavailable" });

      await registered.openVerification?.();
      expect(readAvailable()).toEqual({ available: false, verificationAvailable: true });
      expect(await run({ chatId: verified.chatId, runId: verified.runId })).toEqual({ status: "unavailable" });
      expect(await run(verified)).toEqual({ status: "returned" });
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({
        checkout: "/verified-checkout", electronPath: "/pinned/Electron", requestKind: Verification,
      }));
      expect(prompts).toEqual(["Enable Mac Verification?", "Approve one Electron Desktop preview?"]);

      await registered.openVerification?.();
      expect(prompts.slice(2)).toEqual(["Mac Verification", "Allow Full Access for Mac Verification?"]);
      expect(await run({ ...verified, runId: "run_second" })).toEqual({ status: "returned" });
      expect(prompts).toHaveLength(4);
      expect(pairing).toHaveBeenCalledTimes(3); // One grant proof plus one proof per execution.

      await registered.cancel("stopped");
      expect(await run({ ...verified, runId: "run_third" })).toEqual({ status: "returned" });
      expect(prompts.at(-1)).toBe("Approve one Electron Desktop preview?");
      await registered.cancel();
      expect(readAvailable()).toEqual({ available: false, verificationAvailable: false });
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
  it.each([
    { boundary: "before execution", checksBeforeRevoke: 1, expectedExecutions: 0 },
    { boundary: "before delivery", checksBeforeRevoke: 2, expectedExecutions: 1 },
  ])("requires the original Full Access pairing $boundary", async ({ checksBeforeRevoke, expectedExecutions }) => {
    const profile = await mkdtemp(join(tmpdir(), "matrix-verification-grant-race-"));
    const responses = [1, 2, 1];
    electron.showMessageBox.mockImplementation(async () => ({ response: responses.shift() ?? 0 }));
    execute.mockClear();
    const { ipc, auth, transport, run } = previewFixture();

    let checks = 0;
    const originalPairing = { check: vi.fn(async () => ++checks <= checksBeforeRevoke), close: vi.fn() };
    const freshPairing = { check: vi.fn(async () => true), close: vi.fn() };
    const pairing = vi.fn(async () => freshPairing).mockResolvedValueOnce(originalPairing);
    const registered = registerChatElectronPreview(ipc, {
      auth, transport, allowed: false, macVerificationAllowed: true,
      electronPath: "/Applications/Matrix.app", userData: profile, acquireActionPairing: pairing,
      window: () => ({ isDestroyed: () => false }) as never,
      isTrustedSender: (event) => event === "trusted",
    });
    try {
      await registered.openVerification?.();
      await registered.openVerification?.();
      expect(await run({ chatId: "chat_fixture", runId: "run_grant_race", requestKind: Verification }))
        .toEqual({ status: "unavailable" });
      expect(pairing).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledTimes(expectedExecutions);
      expect(transport.returnResult).not.toHaveBeenCalled();
    } finally {
      await registered.cancel("stopped");
      await rm(profile, { recursive: true, force: true });
    }
  });

});
