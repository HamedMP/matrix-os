import { lstat, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { freezeCodexCanonicalInventory } from "./codex-canonical-tools.mjs";

export const CODEX_CONSTRAINED_VERSION = "0.156.1";
export const CODEX_CONSTRAINED_SOURCE = "b412ff32c417f855c2b2d1581b77058eed87c84b";
// Verified against rust-v0.156.1: features/src/lib.rs, config/src/config_toml.rs,
// core/src/tools/spec_plan.rs, app-server-protocol/src/protocol/v2/thread.rs.
// No generic nativeTools allowlist is exposed by this app-server contract.
export const CODEX_CONSTRAINED_CONFIG = Object.freeze({
  "features.shell_tool": false, "features.view_image": false, "features.hooks": false,
  "features.apps": false, "features.plugins": false, "features.recommended_plugins": false,
  "features.tool_suggest": false, "features.multi_agent": false, "features.multi_agent_v2": false,
  "features.agent_message_board": false, "features.code_mode": false, "features.code_mode_host": true,
  "features.code_mode_prewarm": false, "features.code_mode_only": false,
  "features.browser_use": false, "features.computer_use": false, "features.image_generation": false,
  "features.web_search_request": false, "features.web_search_cached": false, "features.standalone_web_search": false,
  "features.memories": false, "features.external_agent_memory_import": false, "features.chronicle": false,
  "features.goals": false, "features.token_budget": false, "features.current_time_reminder": false,
  "features.sleep_tool": false, "features.deferred_executor": false, "features.send_message_to_user_async": false,
  "features.request_permissions_tool": false, "features.worktrees": false,
  "tools.update_plan.enabled": false, web_search: "disabled",
  "orchestrator.skills.enabled": false, "orchestrator.mcp.enabled": false,
  project_doc_max_bytes: 0, "shell_environment_policy.inherit": "none", allow_login_shell: false,
  cli_auth_credentials_store: "file",
});
export function assertCodexCanonicalConfigLayers(response, home) {
  if (!response || !response.config || !Array.isArray(response.layers) || response.layers.length > 32) throw new Error("canonical_codex_config_unqualified");
  for (const layer of response.layers) {
    const source = layer?.name ?? layer?.source;
    if (!source || !layer.config || typeof layer.config !== "object") throw new Error("canonical_codex_config_unqualified");
    const allowed = source.type === "packagedDefaults" || source.type === "sessionFlags"
      || (source.type === "user" && source.file === join(home, "config.toml") && !source.profile);
    if (!allowed && Object.keys(layer.config).length !== 0) throw new Error("canonical_codex_config_unqualified");
  }
  for (const key of ["mcp_servers", "plugins", "notify", "model_providers"]) {
    const value = response.config[key];
    if (value && Object.keys(value).length !== 0) throw new Error("canonical_codex_config_unqualified");
  }
}
const HOME_TTL_MS = 60 * 60_000;
const MAX_HOMES = 32;
async function info(path) {
  try { return await lstat(path); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}

// Isolation of CODEX_HOME does not suppress system/managed/cloud layers. Never
// pretend empty-table -c overrides delete inherited MCP/plugin map entries.
// Startup must additionally inspect config/read before admitting any model turn.
export async function createCodexQualifiedConfig({ executionPolicy, inventory, expectedVersion, providerThreadId,
  authFile, inheritedEnv = process.env, parentDirectory = join(tmpdir(), "matrix-codex-canonical"), rejectSystemConfig = true }) {
  if (expectedVersion !== CODEX_CONSTRAINED_VERSION || providerThreadId) throw new Error("canonical_codex_unqualified");
  const qualified = freezeCodexCanonicalInventory(executionPolicy, inventory);
  if (rejectSystemConfig && process.platform !== "win32") {
    for (const path of ["/etc/codex/config.toml", "/etc/codex/managed_config.toml", "/etc/codex/requirements.toml"]) {
      if (await info(path)) throw new Error("canonical_codex_config_unqualified");
    }
  }
  const parent = resolve(parentDirectory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (process.getuid && parentInfo.uid !== process.getuid()) || (parentInfo.mode & 0o077) !== 0) throw new Error("canonical_codex_home_unqualified");
  let root;
  async function sweep() {
    // Serialize recurring reclaim across runner processes. A crashed cleanup
    // lock is intentionally not guessed stale: the 32 exclusive slots remain
    // bounded and manual recovery is safer than deleting a newly claimed home.
    const lock = join(parent, ".cleanup-lock");
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") return; throw error; }
    try {
      const entries = await readdir(parent, { withFileTypes: true });
      if (entries.length > 128) throw new Error("canonical_codex_home_limit");
      let count = 0;
      for (const entry of entries) {
        if (!/^run-[A-Za-z0-9]+$/.test(entry.name)) continue;
        const path = join(parent, entry.name); const stat = await info(path);
        if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
        if (path !== root && stat.mtimeMs <= Date.now() - HOME_TTL_MS) await rm(path, { recursive: true, force: true });
        else count += 1;
      }
      return count;
    } finally {
      // Normal completion releases the lock; a crashed sweeper leaves it as an
      // explicit recovery gate rather than risking a double reclaim.
      await rm(lock, { recursive: true, force: true });
    }
  }
  await sweep();
  // Directory creation is the cross-process exclusive claim, not a racy count.
  for (let index = 0; index < MAX_HOMES; index += 1) {
    const candidate = join(parent, `run-${index}`);
    try { await mkdir(candidate, { mode: 0o700 }); root = candidate; break; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  }
  if (!root) throw new Error("canonical_codex_home_limit");
  let timer;
  try {
    const home = join(root, "home"); const cwd = join(root, "workspace");
    await mkdir(home, { mode: 0o700 }); await mkdir(cwd, { mode: 0o700 });
    // File-backed owner CLI auth reuse: inspect metadata only, link just auth.json.
    // No config-directory symlink, credential copy, .env or keyring extraction.
    if (authFile) {
      if (!isAbsolute(authFile) || !authFile.endsWith("/auth.json")) throw new Error("canonical_codex_auth_unqualified");
      const stat = await lstat(authFile);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("canonical_codex_auth_unqualified");
      await symlink(authFile, join(home, "auth.json"));
    }
    const toml = Object.entries(CODEX_CONSTRAINED_CONFIG).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n") + "\n";
    await writeFile(join(home, "config.toml"), toml, { mode: 0o600, flag: "wx" });
    const env = { HOME: home, CODEX_HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share") };
    for (const key of ["PATH", "LANG", "TZ", "SYSTEMROOT", "WINDIR"]) if (typeof inheritedEnv[key] === "string") env[key] = inheritedEnv[key];
    timer = setInterval(() => { void sweep().catch(error => console.warn("[coding-agents] Canonical home sweep failed:", error instanceof Error ? error.name : "UnknownError")); }, 60_000);
    timer.unref();
    return { cwd, env, root, qualified,
      args: ["--strict-config", ...Object.entries(CODEX_CONSTRAINED_CONFIG).flatMap(([k, v]) => ["-c", `${k}=${JSON.stringify(v)}`])],
      threadParams: { cwd, environments: [], dynamicTools: qualified.tools, ephemeral: true, config: CODEX_CONSTRAINED_CONFIG, approvalPolicy: "never", sandbox: "read-only", runtimeWorkspaceRoots: [] },
      async close() { clearInterval(timer); await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) { clearInterval(timer); await rm(root, { recursive: true, force: true }); throw error; }
}
