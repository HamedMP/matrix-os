import { describe, expect, it, vi } from "vitest";
import { createMacKeychainAuthStore } from "../../src/auth/macos-keychain.js";

const AUTH = {
  accessToken: "access-secret",
  refreshToken: `sdr_18e9ee9f-ec1f-45b7-b0c2-b51a47e6da8c.${"a".repeat(43)}`,
  expiresAt: 1_800_000_000_000,
  userId: "user_alice",
  handle: "alice",
  runtimeSlot: "primary",
};

describe("macOS Keychain sync credential adapter", () => {
  it("writes through security batch stdin without putting secret material in argv", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const store = createMacKeychainAuthStore({ run });
    await store.set("18e9ee9f-ec1f-45b7-b0c2-b51a47e6da8c", AUTH);

    expect(run).toHaveBeenCalledOnce();
    const [command, args, input] = run.mock.calls[0]!;
    expect(command).toBe("/usr/bin/security");
    expect(args).toEqual(["-i"]);
    expect(JSON.stringify(args)).not.toContain(AUTH.accessToken);
    expect(input).not.toContain(AUTH.accessToken);
    expect(input).toMatch(/^add-generic-password .* -w [A-Za-z0-9_-]+\n$/);
  });

  it("loads and validates a bounded base64url credential", async () => {
    const encoded = Buffer.from(JSON.stringify(AUTH)).toString("base64url");
    const run = vi.fn(async () => ({ stdout: `${encoded}\n`, stderr: "" }));
    const store = createMacKeychainAuthStore({ run });

    await expect(store.get("18e9ee9f-ec1f-45b7-b0c2-b51a47e6da8c")).resolves.toEqual(AUTH);
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/security",
      ["find-generic-password", "-a", "18e9ee9f-ec1f-45b7-b0c2-b51a47e6da8c", "-s", "com.matrix-os.sync", "-w"],
      undefined,
    );
  });

  it("deletes only the exact service/account item and treats a missing item as absent", async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error("missing"), { exitCode: 44 });
    });
    const store = createMacKeychainAuthStore({ run });
    await expect(store.get("18e9ee9f-ec1f-45b7-b0c2-b51a47e6da8c")).resolves.toBeNull();
    await expect(store.delete("18e9ee9f-ec1f-45b7-b0c2-b51a47e6da8c")).resolves.toBeUndefined();
  });
});
