import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { buildAgentRuntimeEnvironment } from "../../packages/gateway/src/agent-launcher.js";
import { createCodexModelCatalogSource, normalizeCodexModelCatalog } from "../../packages/gateway/src/chat/codex-model-catalog.js";

describe("Codex model catalog projection", () => {
  it("spawns the configured Codex executable with the owner runtime HOME", async () => {
    vi.stubEnv("HOME", "/gateway-home");
    vi.stubEnv("CODEX_HOME", "/explicit-codex-home");
    vi.stubEnv("B4_INHERITED_MARKER", "preserved");
    try {
      const spawnProcess = vi.fn(() => {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
        });
        child.stdin.on("data", (chunk: Buffer) => {
          const message = JSON.parse(chunk.toString()) as { id?: number };
          if (message.id === 1) child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
          if (message.id === 2) child.stdout.write(`${JSON.stringify({
            id: 2,
            result: { data: [{
              id: "fixture-model", model: "fixture-model", displayName: "Fixture Model",
              hidden: false, isDefault: true, defaultReasoningEffort: "low",
              supportedReasoningEfforts: [],
            }], nextCursor: null },
          })}\n`);
        });
        return child as never;
      });
      const runtimeEnvironment = buildAgentRuntimeEnvironment("/owner-home");
      const source = createCodexModelCatalogSource({
        executable: "/owner-bin/codex", cwd: "/owner-home",
        environment: runtimeEnvironment, spawnProcess,
      });

      await expect(source({ id: "codex", kind: "codex", availability: "available" } as never))
        .resolves.toMatchObject({ defaultModel: "fixture-model" });
      const [command, args, spawnOptions] = spawnProcess.mock.calls[0] as unknown as [string, string[], SpawnOptionsWithoutStdio];
      expect(command).toBe("/owner-bin/codex");
      expect(args).toEqual(["app-server", "--stdio"]);
      expect(spawnOptions.cwd).toBe("/owner-home");
      expect(spawnOptions.stdio).toBe("pipe");
      expect(spawnOptions.env?.HOME).toBe("/owner-home");
      expect(spawnOptions.env?.MATRIX_HOME).toBe("/owner-home");
      expect(spawnOptions.env?.PATH).toBe(runtimeEnvironment.PATH);
      expect(spawnOptions.env?.CODEX_HOME).toBe("/explicit-codex-home");
      expect(spawnOptions.env?.B4_INHERITED_MARKER).toBe("preserved");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("projects live app-server models and their effort/service-tier options", () => {
    const catalog = normalizeCodexModelCatalog({
      data: [{
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: "Frontier coding model",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
          { reasoningEffort: "high", description: "Deep" },
        ],
        inputModalities: ["text", "image"],
        serviceTiers: [{ id: "priority", name: "Fast", description: "Priority capacity" }],
        defaultServiceTier: "priority",
      }, {
        id: "hidden-model",
        model: "hidden-model",
        displayName: "Hidden",
        description: "Hidden",
        hidden: true,
        isDefault: false,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [],
      }],
      nextCursor: null,
    });

    expect(catalog).toMatchObject({
      defaultModel: "gpt-5.6-sol",
      models: [{
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        capabilities: ["reasoning", "tools", "vision"],
        supportsVision: true,
      }],
      options: [{
        id: "effort",
        defaultValue: "low",
        values: [{ value: "low" }, { value: "high" }],
      }, {
        id: "service_tier",
        defaultValue: "priority",
        values: [{ value: "priority", label: "Fast" }],
      }],
    });
  });
});
