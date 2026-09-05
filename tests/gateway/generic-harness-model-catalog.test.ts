import { describe, expect, it, vi } from "vitest";
import {
  createGenericHarnessModelCatalogReader,
  parseOpenCodeModelCatalog,
  parsePiModelCatalog,
} from "../../packages/gateway/src/ai-providers/generic-harness-model-catalog.js";

describe("generic harness model catalog", () => {
  it("parses Pi's authenticated provider table into executable provider/model references", () => {
    expect(parsePiModelCatalog(`
provider      model                context  max-out  thinking  images
openai-codex  gpt-5.6-sol          272K     128K     yes       yes
openai-codex  gpt-5.6-terra        272K     128K     yes       yes
`)).toEqual([
      {
        providerId: "openai-codex",
        providerDisplayName: "OpenAI Codex",
        modelId: "openai-codex:gpt-5.6-sol",
        modelDisplayName: "GPT-5.6 Sol",
      },
      {
        providerId: "openai-codex",
        providerDisplayName: "OpenAI Codex",
        modelId: "openai-codex:gpt-5.6-terra",
        modelDisplayName: "GPT-5.6 Terra",
      },
    ]);
  });

  it("parses OpenCode's provider/model lines without losing nested model slugs", () => {
    expect(parseOpenCodeModelCatalog(`
opencode/big-pickle
baseten/deepseek-ai/DeepSeek-V4-Pro
zai-coding-plan/glm-5.3
not a model
`)).toEqual([
      {
        providerId: "opencode",
        providerDisplayName: "OpenCode",
        modelId: "opencode:big-pickle",
        modelDisplayName: "Big Pickle",
      },
      {
        providerId: "baseten",
        providerDisplayName: "Baseten",
        modelId: "baseten:deepseek-ai/DeepSeek-V4-Pro",
        modelDisplayName: "DeepSeek V4 Pro",
      },
      {
        providerId: "zai-coding-plan",
        providerDisplayName: "Z.AI Coding Plan",
        modelId: "zai-coding-plan:glm-5.3",
        modelDisplayName: "GLM-5.3",
      },
    ]);
  });

  it("projects each live catalog as a harness-owned access route and degrades independently", async () => {
    const run = vi.fn(async (command: string) => {
      if (command === "pi") throw new Error("private command failure");
      return { stdout: "openai/gpt-5.6-sol\nbaseten/zai-org/GLM-5.3\n", stderr: "" };
    });
    const reader = createGenericHarnessModelCatalogReader({
      homePath: "/home/matrix/home",
      enabledHarnesses: ["pi", "opencode"],
      run,
      now: () => new Date("2026-08-31T12:00:00.000Z"),
    });

    const catalog = await reader.getCatalog({ refresh: true });

    expect(run).toHaveBeenCalledWith(expect.stringMatching(/(?:^|\/)pi$/), [
      "--list-models", "--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-context-files", "--no-approve",
    ], expect.objectContaining({
      cwd: "/home/matrix/home",
      timeoutMs: 5_000,
      maxOutputBytes: 256 * 1024,
    }));
    expect(run).toHaveBeenCalledWith("opencode", ["models"], expect.objectContaining({
      env: expect.objectContaining({
        HOME: "/home/matrix/home", NO_COLOR: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
      }),
    }));
    expect(catalog.providers.map((provider) => provider.displayName)).toEqual(["Baseten", "OpenAI"]);
    expect(catalog.accessSources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "harness_profile",
        harness: "opencode",
        providerId: "openai",
        displayName: "OpenCode account",
        eligibleModelIds: ["openai:gpt-5.6-sol"],
      }),
      expect.objectContaining({
        kind: "harness_profile",
        harness: "opencode",
        providerId: "baseten",
        displayName: "OpenCode account",
        eligibleModelIds: ["baseten:zai-org/GLM-5.3"],
      }),
    ]));
    expect(catalog.failures).toEqual(["pi"]);
    expect(JSON.stringify(catalog)).not.toContain("private command failure");
  });

  it("caps the merged provider catalog when Pi and OpenCode expose disjoint model sets", async () => {
    const piModels = Array.from({ length: 256 }, (_, index) => `openai model-${index}`).join("\n");
    const openCodeModels = Array.from({ length: 256 }, (_, index) => `openai/model-${index + 256}`).join("\n");
    const reader = createGenericHarnessModelCatalogReader({
      homePath: "/home/matrix/home",
      enabledHarnesses: ["pi", "opencode"],
      run: vi.fn(async (command: string) => ({
        stdout: command === "opencode" ? openCodeModels : piModels,
        stderr: "",
      })),
    });

    const catalog = await reader.getCatalog({ refresh: true });

    expect(catalog.providers).toHaveLength(1);
    expect(catalog.providers[0]!.models).toHaveLength(256);
  });
});
