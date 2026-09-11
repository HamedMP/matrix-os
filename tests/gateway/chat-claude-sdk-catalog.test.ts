import { describe, expect, it, vi } from "vitest";
import { readClaudeModelInventory } from "../../packages/kernel/src/claude-model-inventory.js";
import { createClaudeModelCatalogSource } from "../../packages/gateway/src/chat/claude-model-catalog.js";
import { createRuntimeClaudeModelCatalogSource } from "../../packages/gateway/src/chat/claude-runtime-model-catalog.js";
import { fileURLToPath } from "node:url";

describe("Claude SDK catalog metadata boundary", () => {
  it.each(["stdout", "stderr"])("rejects oversized native %s during metadata initialization", async (output) => {
    const controller = new AbortController();
    try {
      await expect(readClaudeModelInventory({
        executable: fileURLToPath(new URL("../fixtures/claude-model-inventory.mjs", import.meta.url)),
        cwd: process.cwd(), env: { PATH: process.env.PATH, MATRIX_TEST_INVENTORY_OVERSIZE: output },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)]),
      })).rejects.toThrow("Claude inventory output limit exceeded");
    } finally { controller.abort(); }
  });

  it("reads supportedModels without submitting user input and closes the metadata session", async () => {
    let closed = false;
    let userMessages = 0;
    let consumption: Promise<void> | undefined;
    const source = createClaudeModelCatalogSource({ discover: (signal) => readClaudeModelInventory({
      executable: "claude", cwd: "/runtime-home", env: { HOME: "/runtime-home" }, signal,
      queryFn: (input) => {
        expect(input.options).toMatchObject({
          pathToClaudeCodeExecutable: "claude", cwd: "/runtime-home", persistSession: false,
          tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {},
          settings: { disableAllHooks: true }, permissionMode: "default",
        });
        if (typeof input.prompt === "string") throw new Error("Metadata must not send a prompt");
        consumption = (async () => { for await (const _message of input.prompt) userMessages++; })();
        return {
          supportedModels: async () => [{ value: "claude-fable-5", displayName: "Fable", description: "" }],
          close: () => { closed = true; },
        };
      },
    }) });
    const catalog = await source({ id: "claude", kind: "claude", availability: "available" } as never,
      { userId: "owner_sdk_catalog", source: "jwt" });
    await consumption;
    expect(catalog?.models.map((model) => model.id)).toContain("claude-fable-5");
    expect(userMessages).toBe(0);
    expect(closed).toBe(true);
  });

  it("uses canonical Chat's launch scope and changes inventory when its API credential changes", async () => {
    let key = "synthetic-key-one";
    const source = createRuntimeClaudeModelCatalogSource({
      homePath: "/runtime-home",
      resolveCredentialLaunch: async () => ({ env: { HOME: "/wrong-home", ANTHROPIC_API_KEY: key } }),
      readInventory: async (input) => {
        expect(input.executable).toBe("claude");
        expect(input.cwd).toBe("/runtime-home");
        expect(input.env.HOME).toBe("/runtime-home");
        expect(input.env.ANTHROPIC_API_KEY).toBe(key);
        return [{ value: key === "synthetic-key-one" ? "claude-fable-5" : "claude-fable-5-1", displayName: "Fable" }];
      },
    });
    const provider = { id: "claude", kind: "claude", availability: "available" } as never;
    const principal = { userId: "owner_sdk_catalog", source: "jwt" as const };
    expect((await source(provider, principal))?.models.map((model) => model.id)).toContain("claude-fable-5");
    key = "synthetic-key-two";
    expect((await source(provider, principal))?.models.map((model) => model.id)).toContain("claude-fable-5-1");
  });

  it("closes an unresponsive SDK metadata session when its catalog deadline expires", async () => {
    vi.useFakeTimers();
    let closed = false;
    try {
      const source = createClaudeModelCatalogSource({ timeoutMs: 10, discover: (signal) => readClaudeModelInventory({
        executable: "claude", cwd: "/runtime-home", env: {}, signal,
        queryFn: () => ({ supportedModels: () => new Promise(() => {}), close: () => { closed = true; } }),
      }) });
      const result = source({ id: "claude", kind: "claude", availability: "available" } as never,
        { userId: "owner_sdk_catalog", source: "jwt" });
      await vi.advanceTimersByTimeAsync(20);
      await expect(result).resolves.toBeNull();
      expect(closed).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("uses the real SDK initialization protocol without inheriting removed service credentials", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-ambient-key");
    try {
      const source = createClaudeModelCatalogSource({ discover: (signal) => readClaudeModelInventory({
        executable: fileURLToPath(new URL("../fixtures/claude-model-inventory.mjs", import.meta.url)),
        cwd: process.cwd(), env: { PATH: process.env.PATH }, signal,
      }) });
      const catalog = await source({ id: "claude", kind: "claude", availability: "available" } as never,
        { userId: "owner_sdk_protocol", source: "jwt" });
      expect(catalog?.models.map((model) => model.id)).toContain("claude-fable-5");
      expect(catalog?.models.map((model) => model.id)).not.toContain("unexpected-ambient-credential");
    } finally { vi.unstubAllEnvs(); }
  });
});
