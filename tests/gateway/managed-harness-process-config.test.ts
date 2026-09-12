import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preparePiRunEnvironment, buildOpenCodeRunConfiguration } from "../../packages/gateway/src/coding-agents/managed-harness-process-config.js";

describe("managed generic harness process configuration", () => {
  it("uses an isolated persistent Pi models configuration without writing the lease token", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-managed-config-"));
    try {
      const env = await preparePiRunEnvironment({ homePath: home, credentials: { OPENAI_API_KEY: "private-lease", OPENAI_BASE_URL: "https://relay.example.test/v1" } });
      const content = await readFile(join(env.PI_CODING_AGENT_DIR!, "models.json"), "utf8");
      expect(content).not.toContain("private-lease");
      expect(JSON.parse(content).providers.cloudflare).toMatchObject({ api: "openai-completions", apiKey: "OPENAI_API_KEY", models: [{ id: "@cf/zai-org/glm-5.3-flash", input: ["text"] }] });
      expect(env).toMatchObject({ HOME: home, OPENAI_API_KEY: "private-lease" });
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it("uses OpenCode's OpenAI-compatible adapter and disables the remote title agent", () => {
    const config = JSON.parse(buildOpenCodeRunConfiguration({ OPENAI_API_KEY: "lease", OPENAI_BASE_URL: "https://relay.example.test/v1" }));
    expect(config.provider.cloudflare).toMatchObject({ npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://relay.example.test/v1", apiKey: "{env:OPENAI_API_KEY}" } });
    expect(config.agent.title.disable).toBe(true);
    expect(config.provider.anthropic).toBeUndefined();
  });
  it("keeps own-account Pi configuration untouched", async () => {
    const env = await preparePiRunEnvironment({ homePath: "/home/example", credentials: { ANTHROPIC_API_KEY: "own-key" } });
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("own-key");
  });
});
