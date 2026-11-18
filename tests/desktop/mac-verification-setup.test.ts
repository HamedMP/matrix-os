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
  const replies: number[] = [];
  const stop = vi.fn();
  const resolveSource = vi.fn(async () => source);
  const prompt = vi.fn(async () => replies.shift() ?? 0);
  const setup = createMacVerificationSetup({
    getStatus: () => status, pickDirectory: vi.fn(async () => source.checkout),
    resolveSource, prompt, stop,
  });
  return { setup, replies, prompt, stop, resolveSource,
    setStatus: (next: AuthStatus) => { status = next; },
  };
};

describe("Mac Verification native setup", () => {
  it("enables a native checkout and keeps disabling verification available", async () => {
    const { setup, replies, prompt, stop } = verdict();
    expect(setup.enabled()).toBe(false);
    replies.push(1);
    await setup.open();
    expect(setup.enabled()).toBe(true);
    expect(await setup.resolveActiveSource(new AbortController().signal)).toEqual(source);
    replies.push(1);
    await setup.open();
    expect(prompt).toHaveBeenLastCalledWith(expect.objectContaining({ buttons: ["Done", "Disable Verification"] }));
    expect(setup.enabled()).toBe(false);
    expect(stop).toHaveBeenCalledWith("stopped");
  });

  it("rejects a replacement Computer and requires a new native checkout selection", async () => {
    const { setup, replies, setStatus } = verdict();
    replies.push(1);
    await setup.open();
    setStatus({ ...account, handle: "other-machine", authGeneration: 2 });
    expect(setup.enabled()).toBe(false);
    setStatus(account);
    expect(setup.enabled()).toBe(false);
  });

  it("denies a replaced local checkout", async () => {
    const { setup, replies, resolveSource, stop } = verdict();
    replies.push(1);
    await setup.open();
    resolveSource.mockResolvedValue({ ...source, identity: "changed" });
    expect(await setup.resolveActiveSource(new AbortController().signal)).toBeNull();
    expect(setup.enabled()).toBe(false);
    expect(stop).toHaveBeenCalledWith("revoked");
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
