import { describe, expect, it, vi } from "vitest";
import { readMatrixInventory } from "../../desktop/src/main/desktop-link/matrix-inventory";

const signedIn = { signedIn: true as const, userId: "owner", authGeneration: 3, handle: "main", runtimeSlot: "primary", platformHost: "https://matrix.test" };

describe("linked desktop account-computer inventory", () => {
  it("projects the Terminal sidebar list without paths, permissions or duplicated primary, and preserves incomplete pages", async () => {
    const items = [
      { runtimeSlot: "primary", handle: "main", availability: "available" },
      { runtimeSlot: "dev", handle: "my-dev", availability: "available" },
      { runtimeSlot: "pr-23", handle: "my-dev", availability: "starting" },
    ] as const;
    const auth = { getStatus: () => signedIn, listRuntimeComputers: async () => ({ items, hasMore: true }) };
    expect(await readMatrixInventory(auth, "owner")).toEqual({
      machines: [
        { source: "matrix", name: "my-dev", runtimeSlot: "dev", state: "connected" },
        { source: "matrix", name: "my-dev", runtimeSlot: "pr-23", state: "unknown" },
      ], partial: true,
    });
  });

  it("does not request another owner's sidebar", async () => {
    const listRuntimeComputers = vi.fn();
    await expect(readMatrixInventory({ getStatus: () => signedIn, listRuntimeComputers }, "other")).rejects.toThrow();
    expect(listRuntimeComputers).not.toHaveBeenCalled();
  });

  it("drops a reply after the authenticated session was replaced while loading", async () => {
    const getStatus = vi.fn().mockReturnValueOnce(signedIn).mockReturnValue({ ...signedIn, authGeneration: 4 });
    await expect(readMatrixInventory({ getStatus, listRuntimeComputers: async () => ({ items: [], hasMore: false }) }, "owner")).rejects.toThrow();
  });
});
