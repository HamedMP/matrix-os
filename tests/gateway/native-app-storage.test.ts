import { describe, expect, it, vi } from "vitest";
import type { AppRegistry, RegisterOpts } from "../../packages/gateway/src/app-db-registry.js";
import { registerNativeAppStorage } from "../../packages/gateway/src/native-app-storage.js";

function registryWith(register: (options: RegisterOpts) => Promise<void>): AppRegistry {
  return {
    register,
    unregister: vi.fn(),
    get: vi.fn(),
    listApps: vi.fn(),
    getSchema: vi.fn(),
  };
}

describe("native app storage", () => {
  it("provisions the Notes schema without a filesystem app manifest", async () => {
    const register = vi.fn(async (_options: RegisterOpts) => {});

    await expect(registerNativeAppStorage(registryWith(register))).resolves.toEqual(["notes"]);
    expect(register).toHaveBeenCalledWith({
      slug: "notes",
      name: "Notes",
      description: "Native Matrix OS notes",
      version: "1.0.0",
      author: "system",
      category: "productivity",
      tables: {
        notes: {
          columns: {
            title: "text",
            content: "text",
            content_json: "jsonb",
            pinned: "boolean",
            tags: "text",
          },
          indexes: ["pinned"],
        },
      },
    });
  });

  it("reports no provisioned slug when registration fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const register = vi.fn(async () => { throw new Error("database unavailable"); });

    try {
      await expect(registerNativeAppStorage(registryWith(register))).resolves.toEqual([]);
      expect(error).toHaveBeenCalledWith(
        "[app-db] Native storage registration failed for notes:",
        "database unavailable",
      );
    } finally {
      error.mockRestore();
    }
  });
});
