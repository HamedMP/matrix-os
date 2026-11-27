import { describe, expect, it, vi } from "vitest";
import type { AuthStatus } from "@desktop/main/auth/auth-service";
import { createMacVerificationSetup } from "@desktop/main/chat-electron-preview/verification-setup";

const source = {
  checkout: "/repo",
  electronPath: "/vendor/Electron",
  identity: "checkout-and-executable-identity",
};
const account: AuthStatus = {
  signedIn: true,
  userId: "owner_1",
  handle: "matrix-owner",
  platformHost: "https://app.matrix-os.com",
  runtimeSlot: "primary",
  authGeneration: 1,
};
const verdict = (main: AuthStatus = account) => {
  let status = main;
  let now = 1_000;
  const replies: number[] = [];
  const close = vi.fn();
  const stop = vi.fn();
  const check = vi.fn(async (_signal?: AbortSignal, _retryBadGateway?: () => boolean) => true);
  const acquirePairing = vi.fn(async (_operation: AbortController) => ({ check, close }));
  const resolveSource = vi.fn(async () => source);
  const setup = createMacVerificationSetup({
    getStatus: () => status, pickDirectory: vi.fn(async () => source.checkout),
    resolveSource, prompt: vi.fn(async () => replies.shift() ?? 0),
    acquirePairing, stop, now: () => now,
  });
  return { setup, replies, check, close, stop, acquirePairing, resolveSource,
    setStatus: (next: AuthStatus) => { status = next; },
    advance: (ms: number) => { now += ms; },
  };
};

describe("Mac Verification native setup", () => {
  it("requires a native checkout selection and separately grants bounded Full Access", async () => {
    const { setup, replies, acquirePairing, stop } = verdict();
    expect(setup.enabled()).toBe(false);
    replies.push(1);
    await setup.open();
    expect(setup.enabled()).toBe(true);
    expect(await setup.resolveActiveSource(new AbortController().signal)).toEqual(source);
    expect(acquirePairing).not.toHaveBeenCalled();
    expect(await setup.getFullAccessApproval(new AbortController().signal)).toBeNull();
    replies.push(2, 1);
    await setup.open();
    expect(acquirePairing).toHaveBeenCalledOnce();
    expect(await setup.getFullAccessApproval(new AbortController().signal)).toMatchObject({ check: expect.any(Function) });
    setup.revokeFullAccess("stopped");
    expect(await setup.getFullAccessApproval(new AbortController().signal)).toBeNull();
    expect(stop).toHaveBeenCalledWith("revoked");
    expect(setup.enabled()).toBe(true);
  });

  it("rejects a replacement Computer and requires a new native checkout selection", async () => {
    const { setup, replies, setStatus, close } = verdict();
    replies.push(1, 2, 1);
    await setup.open();
    await setup.open();
    setStatus({ ...account, handle: "other-machine", authGeneration: 2 });
    expect(setup.enabled()).toBe(false);
    expect(await setup.getFullAccessApproval(new AbortController().signal)).toBeNull();
    expect(close).toHaveBeenCalledOnce();
    setStatus(account);
    expect(setup.enabled()).toBe(false);
  });

  it("expires grants and denies a replaced local checkout", async () => {
    const { setup, replies, advance, resolveSource } = verdict();
    replies.push(1, 2, 1);
    await setup.open();
    await setup.open();
    advance(15 * 60_000);
    expect(await setup.getFullAccessApproval(new AbortController().signal)).toBeNull();
    resolveSource.mockResolvedValue({ ...source, identity: "changed" });
    expect(await setup.resolveActiveSource(new AbortController().signal)).toBeNull();
    expect(setup.enabled()).toBe(false);
  });

  it("ends Full Access when the pairing lease no longer matches", async () => {
    const { setup, replies, check, close } = verdict();
    replies.push(1, 2, 1);
    await setup.open();
    await setup.open();
    check.mockResolvedValue(false);
    expect(await setup.getFullAccessApproval(new AbortController().signal)).toBeNull();
    expect(close).toHaveBeenCalledOnce();
    expect(setup.enabled()).toBe(true);
  });

  it("refuses a delivery pairing retry when Full Access expires during its first read", async () => {
    const { setup, replies, advance, check, close } = verdict();
    replies.push(1, 2, 1);
    await setup.open();
    await setup.open();
    const { signal } = new AbortController();
    const approval = (await setup.getFullAccessApproval(signal))!;
    const retryBadGateway = vi.fn(() => true);
    check.mockImplementationOnce(async (_signal, retryPairingRead) => {
      advance(15 * 60_000);
      expect(retryPairingRead?.()).toBe(false);
      return false;
    });
    await expect(approval.check(signal, retryBadGateway)).resolves.toBe(false);
    expect(retryBadGateway).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("discards a checkout selection if the account changes during the native prompt", async () => {
    const { setup, replies, setStatus, resolveSource } = verdict();
    replies.push(1);
    resolveSource.mockImplementation(async () => {
      setStatus({ ...account, authGeneration: 2 });
      return source;
    });
    await setup.open();
    expect(setup.enabled()).toBe(false);
  });
});
