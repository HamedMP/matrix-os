import { mkdtemp, mkdir, readlink, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCodexQualifiedConfig, CODEX_CONSTRAINED_CONFIG, assertCodexCanonicalConfigLayers } from "../../packages/gateway/src/coding-agents/codex-qualified-config.mjs";
const policy = { revision: "r1", actionMode: "conversation_only", workspaceScope: "owner", tools: [], delegation: false };
it("uses verified keys, empty environments, clean home/cwd/env and a link-only sanctioned file auth path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mx-qualified-test-"));
  const owner = join(dir, "owner"); await mkdir(owner);
  await writeFile(join(owner, "auth.json"), "fake-auth-never-read", { mode: 0o600 });
  await writeFile(join(owner, "config.toml"), "[mcp_servers.escape]\ncommand = 'evil'\n");
  const runtime = await createCodexQualifiedConfig({ executionPolicy: policy, inventory: [], expectedVersion: "0.161.0", authFile: join(owner, "auth.json"), parentDirectory: join(dir, "isolated"), inheritedEnv: { CODEX_HOME: owner, HOME: owner, NODE_OPTIONS: "--require evil", OPENAI_API_KEY: "secret", PATH: "/usr/bin", MCP_CONFIG: "evil" }, rejectSystemConfig: false });
  try {
    expect(runtime.env.CODEX_HOME).toBe(await realpath(runtime.env.CODEX_HOME));
    assertCodexCanonicalConfigLayers({ config: {}, layers: [{ name: { type: "user", file: await realpath(join(runtime.env.CODEX_HOME, "config.toml")) }, config: CODEX_CONSTRAINED_CONFIG }] }, runtime.env.CODEX_HOME);
    expect(runtime.threadParams).toMatchObject({ environments: [], dynamicTools: [], ephemeral: true, config: CODEX_CONSTRAINED_CONFIG });
    expect(runtime.threadParams).not.toHaveProperty("nativeTools");
    expect(runtime.env.CODEX_HOME).not.toBe(owner); expect(runtime.cwd).not.toBe(owner);
    expect(runtime.env).not.toHaveProperty("OPENAI_API_KEY"); expect(runtime.env).not.toHaveProperty("NODE_OPTIONS"); expect(runtime.env).not.toHaveProperty("MCP_CONFIG");
    expect(await readlink(join(runtime.env.CODEX_HOME, "auth.json"))).toBe(join(owner, "auth.json"));
    expect(await readdir(runtime.env.CODEX_HOME)).toEqual(["auth.json", "config.toml"]);
    expect(CODEX_CONSTRAINED_CONFIG).toMatchObject({ "features.shell_tool": false, "features.multi_agent": false, "features.hooks": false, "features.plugins": false, "features.apps": false, "features.daemon_auto_start": false, "cloud.skills.enabled": false, "tools.update_plan.enabled": false, web_search: "disabled" });
    expect(runtime.args).toContain("features.shell_tool=false");
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});
it("rejects inherited managed/project/MCP/plugin config before admitting a model turn", () => {
  const home = "/tmp/isolated";
  for (const type of ["mdm", "project", "enterpriseManaged", "system"]) {
    expect(() => assertCodexCanonicalConfigLayers({ config: {}, layers: [{ name: { type }, config: { features: { hooks: true } } }] }, home)).toThrow();
  }
  for (const key of ["mcp_servers", "plugins", "notify", "model_providers"]) expect(() => assertCodexCanonicalConfigLayers({ config: { [key]: { escape: {} } }, layers: [] }, home)).toThrow();
  expect(() => assertCodexCanonicalConfigLayers({ config: {}, layers: [{ name: { type: "user", file: "/owner/.codex/config.toml" }, config: { hooks: {} } }] }, home)).toThrow();
});
it("atomically caps concurrent isolated homes and rejects overflow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mx-qualified-cap-"));
  const options = { executionPolicy: policy, inventory: [], expectedVersion: "0.161.0", parentDirectory: join(dir, "homes"), rejectSystemConfig: false };
  const settled = await Promise.allSettled(Array.from({ length: 34 }, () => createCodexQualifiedConfig(options)));
  const successful = settled.filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled");
  try { expect(successful).toHaveLength(32); }
  finally { await Promise.all(successful.map(r => r.value.close())); await rm(dir, { recursive: true, force: true }); }
});
it("rejects unpinned versions, delegation, and unconstrained native resume before creating homes", async () => {
  for (const overrides of [{ expectedVersion: "0.144.5" }, { providerThreadId: "old-native" }, { executionPolicy: { ...policy, delegation: true } }]) {
    await expect(createCodexQualifiedConfig({ executionPolicy: policy, inventory: [], expectedVersion: "0.161.0", ...overrides })).rejects.toThrow();
  }
});
