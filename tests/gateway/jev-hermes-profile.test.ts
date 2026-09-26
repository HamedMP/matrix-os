import { describe, expect, it } from "vitest";
import { readFile, access } from "node:fs/promises";
import { createJevHermesProfile, createJevHermesCatalogGate } from "../../packages/gateway/src/chat/jev-hermes-profile.js";
const credentials = { provider: "anthropic" as const, model: "claude-sonnet-5", apiMode: "anthropic_messages" as const,
  baseUrl: "https://api.anthropic.com" as const, env: { ANTHROPIC_API_KEY: "sk-ant-api03-synthetic-only" } };
describe("immutable recipe-only Hermes inputs", () => {
  it("writes isolated broker-only config, keeps key in memory, and deletes owned profile", async () => {
    const profile = await createJevHermesProfile(credentials, "a".repeat(64));
    const config = JSON.parse(await readFile(`${profile.homePath}/hermes/config.yaml`, "utf8"));
    try {
      expect(config.model).toMatchObject({ provider: "anthropic", default: "claude-sonnet-5", api_mode: "anthropic_messages" });
      expect(config.tools).toEqual({ tool_search: false });
      expect(Object.keys(config.mcp_servers)).toEqual(["matrix_jev_recipe"]);
      expect(config.mcp_servers.matrix_jev_recipe.args).toEqual(["--require-scoped-capability", "--tool-surface=jev-inbox-preview"]);
      expect(config.auxiliary.title_generation.enabled).toBe(false); expect(config.auxiliary.background_review.enabled).toBe(false);
      expect(JSON.stringify(config)).not.toContain("sk-ant-api"); expect(JSON.stringify(config)).not.toContain("a".repeat(64));
      expect(profile.env.HOME).toBe(profile.homePath); expect(profile.env.HERMES_HOME).toBe(`${profile.homePath}/hermes`);
      expect(profile.env.HERMES_TUI_TOOLSETS).toBe("matrix_jev_recipe");
      expect(profile.env.ANTHROPIC_API_KEY).toBe(credentials.env.ANTHROPIC_API_KEY);
      expect(profile.env.UPGRADE_TOKEN).toBeUndefined(); expect(profile.env.PYTHONPATH).toBeUndefined();
    } finally { await profile.close(); }
    await expect(access(profile.homePath)).rejects.toThrow();
  });
  it.each(["extra", "empty", "lazy", "foreign-session", "malformed"])("rejects %s catalog before any inference", async (mode) => {
    const gate = createJevHermesCatalogGate(); gate.setSession("live_fixture");
    gate.observe({ type: "session.info", session_id: mode === "foreign-session" ? "other" : "live_fixture",
      payload: { lazy: mode === "lazy", tools: mode === "malformed" ? { x: "terminal" } : { matrix_jev_recipe:
        mode === "empty" ? [] : mode === "extra" ? ["mcp__matrix_jev_recipe__jev_inbox_preview", "terminal"] : ["mcp__matrix_jev_recipe__jev_inbox_preview"] } } });
    const controller = new AbortController();
    if (mode === "foreign-session" || mode === "lazy") controller.abort();
    await expect(gate.ready(controller.signal)).rejects.toThrow();
  });
  it("holds until exact nonlazy sole broker catalog of the selected native session", async () => {
    const gate = createJevHermesCatalogGate();
    gate.observe({ type: "session.info", session_id: "live_fixture", payload: { lazy: false, tools: { matrix_jev_recipe: ["mcp__matrix_jev_recipe__jev_inbox_preview"] } } });
    gate.setSession("live_fixture"); await expect(gate.ready(new AbortController().signal)).resolves.toBeUndefined();
  });
});
