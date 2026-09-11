import { describe, expect, it, vi } from "vitest";
import {
  createNativeCodingModelCatalogSource,
  normalizeOpenCodeModelCatalog,
  normalizePiModelCatalog,
} from "../../packages/gateway/src/chat/native-coding-model-catalog.js";

describe("native coding model catalogs", () => {
  it("projects Pi's bounded table into explicit provider-qualified models", () => {
    expect(normalizePiModelCatalog([
      "provider   model                    context  max-out  thinking  images",
      "anthropic  claude-sonnet-5          200k     64k      yes       yes",
      "opencode   big-pickle               114k     16k      yes       no",
    ].join("\n"))).toEqual({
      models: [{
        id: "anthropic:claude-sonnet-5",
        displayName: "claude-sonnet-5",
        capabilities: ["reasoning", "tools", "vision"],
        supportsVision: true,
        supportsToolUse: true,
      }, {
        id: "opencode:big-pickle",
        displayName: "big-pickle",
        capabilities: ["reasoning", "tools"],
        supportsVision: false,
        supportsToolUse: true,
      }],
      options: [],
      defaultModel: "anthropic:claude-sonnet-5",
    });
  });

  it("projects OpenCode's line protocol and rejects diagnostics as model ids", () => {
    expect(normalizeOpenCodeModelCatalog([
      "anthropic/claude-sonnet-5",
      "opencode/big-pickle",
    ].join("\n"))).toMatchObject({
      models: [
        { id: "anthropic:claude-sonnet-5" },
        { id: "opencode:big-pickle" },
      ],
      defaultModel: "anthropic:claude-sonnet-5",
    });
    expect(() => normalizeOpenCodeModelCatalog("Downloading providers..."))
      .toThrow("OpenCode model catalog is invalid");
  });

  it.each([
    ["pi", [
      "provider   model            context  max-out  thinking  images",
      "anthropic  claude-sonnet-5  200k     64k      yes       yes",
    ].join("\n")],
    ["opencode", "anthropic/claude-sonnet-5\n"],
  ] as const)("runs %s discovery with the owner home and hardened bounded invocation", async (kind, stdout) => {
    const runCommand = vi.fn(async () => ({ stdout, stderr: "" }));
    const source = createNativeCodingModelCatalogSource({
      homePath: "/home/matrix/home",
      env: { HOME: "/wrong-service-home", PATH: "/runtime/bin", DATABASE_URL: "secret" },
      runCommand,
      cacheTtlMs: 1,
    });

    await expect(source({ id: kind, kind, availability: "available" } as never)).resolves.toMatchObject({
      defaultModel: "anthropic:claude-sonnet-5",
    });
    const [command, args, options] = runCommand.mock.calls[0]!;
    expect(command).toBe(kind === "pi" ? "pi" : "opencode");
    expect(args).toEqual(kind === "pi"
      ? [
          "--list-models",
          "--offline",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-approve",
        ]
      : ["models"]);
    expect(options).toMatchObject({
      cwd: "/home/matrix/home",
      timeout: 5_000,
      env: expect.objectContaining({ HOME: "/home/matrix/home", PATH: "/runtime/bin" }),
    });
    expect(options.env).not.toHaveProperty("DATABASE_URL");
  });

  it("does not cache a failed discovery", async () => {
    const runCommand = vi.fn()
      .mockRejectedValueOnce(new Error("private CLI detail"))
      .mockResolvedValueOnce({ stdout: "anthropic/claude-sonnet-5\n", stderr: "" });
    const source = createNativeCodingModelCatalogSource({
      homePath: "/home/matrix/home",
      runCommand,
    });

    await expect(source({ id: "opencode", kind: "opencode", availability: "available" } as never)).rejects.toThrow();
    await expect(source({ id: "opencode", kind: "opencode", availability: "available" } as never)).resolves.toMatchObject({
      defaultModel: "anthropic:claude-sonnet-5",
    });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
});
