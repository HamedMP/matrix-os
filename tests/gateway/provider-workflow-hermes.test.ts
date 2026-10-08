import { afterEach, expect, it, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERMES_CODEX_REUSE_SCRIPT } from "../../packages/gateway/src/ai-providers/provider-workflow-hermes.js";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(imported: boolean, fails = false) {
  const root = await mkdtemp(join(tmpdir(), "matrix-hermes-workflow-test-")); directories.push(root);
  const modulePath = join(root, "hermes_cli"); await mkdir(modulePath);
  await writeFile(join(modulePath, "__init__.py"), "");
  await writeFile(join(modulePath, "auth_codex.py"), 'def _codex_base_url():\n    return "https://chatgpt.com/backend-api/codex"\n');
  await writeFile(join(modulePath, "auth.py"), `
def _import_codex_cli_tokens():
    print("fixture-secret-native-output")
    return ${imported ? '{"access_token": "fixture-secret", "refresh_token": "fixture-refresh"}' : 'None'}
def _save_codex_tokens(tokens):
    ${fails ? 'raise RuntimeError("fixture-secret-private-error")' : 'open("saved-marker", "w").write("saved")'}
def _update_config_for_provider(provider, url):
    open("provider-marker", "w").write(provider)
`);
  return { root, run: () => promisify(execFile)("python3", ["-c", HERMES_CODEX_REUSE_SCRIPT], { cwd: root, env: { PATH: process.env.PATH, PYTHONPATH: root }, timeout: 10000, maxBuffer: 4096 }) };
}
it("calls Hermes native import without emitting credential content", async () => {
  const f = await fixture(true); const result = await f.run();
  expect(result.stdout).toBe(""); expect(result.stderr).toBe("");
  expect(await readFile(join(f.root, "saved-marker"), "utf8")).toBe("saved");
  expect(await readFile(join(f.root, "provider-marker"), "utf8")).toBe("openai-codex");
});
it("missing Codex login does not write or switch the native provider", async () => {
  const f = await fixture(false); await expect(f.run()).rejects.toMatchObject({ code: 2, stdout: "", stderr: "" });
  await expect(readFile(join(f.root, "provider-marker"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("contains native exceptions without outputting credential-bearing traceback", async () => {
  const f = await fixture(true, true); await expect(f.run()).rejects.toMatchObject({ code: 1, stdout: "", stderr: "" });
  await expect(readFile(join(f.root, "provider-marker"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(['openai','anthropic','openrouter'])('native secure key worker persists only the selected %s API key without leaking it', async provider => {
  const { HERMES_SETTINGS_KEY_WORKER } = await import('../../packages/gateway/src/ai-providers/hermes-settings-auth.js');
  const root = await mkdtemp(join(tmpdir(), 'hermes-api-key-')); directories.push(root);
  await mkdir(join(root, 'hermes_cli')); await writeFile(join(root, 'hermes_cli/__init__.py'), '');
  await writeFile(join(root, 'hermes_cli/config.py'), `
import json
values = {}
def require_env_writable(name, operation):
    if operation != 'set': raise RuntimeError('private-error')
def save_env_value_secure(name, key):
    values[name] = key
    open('saved-marker', 'w').write(name)
    print('private-key-output')
    return {'success': True}
def get_env_value(name): return values.get(name)
`);
  const child = execFile('python3', ['-c', HERMES_SETTINGS_KEY_WORKER, 'key'], { cwd: root, env: { PATH: process.env.PATH, PYTHONPATH: root }, timeout: 10000, maxBuffer: 4096 });
  child.stdin!.end(JSON.stringify({ provider, key: 'fixture-secret-key' }));
  const result = await new Promise<{stdout:string;stderr:string}>((resolve, reject) => { let stdout='';let stderr=''; child.stdout!.on('data', chunk => { stdout+=chunk; }); child.stderr!.on('data', chunk => { stderr+=chunk; }); child.on('error', reject); child.on('close', code => code === 0 ? resolve({stdout,stderr}) : reject(new Error('failed'))); });
  expect(result).toEqual({ stdout: '', stderr: '' });
  expect(await readFile(join(root, 'saved-marker'), 'utf8')).toBe({ openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' }[provider]);
});
it.each(["missing_helper", "not_writable", "readback_mismatch", "unknown_provider"])("refuses an unqualified native key write (%s) without credential-bearing output", async failure => {
  const { HERMES_SETTINGS_KEY_WORKER } = await import("../../packages/gateway/src/ai-providers/hermes-settings-auth.js");
  const root = await mkdtemp(join(tmpdir(), "hermes-key-failure-")); directories.push(root);
  await mkdir(join(root, "hermes_cli")); await writeFile(join(root, "hermes_cli/__init__.py"), "");
  await writeFile(join(root, "hermes_cli/config.py"), failure === "missing_helper" ? "" : `
def require_env_writable(name, operation):
    ${failure === "not_writable" ? 'raise RuntimeError("fixture-secret-private-error")' : 'pass'}
def save_env_value_secure(name, key):
    print("fixture-secret-private-output")
    return {'success': True}
def get_env_value(name): return "mismatched-secret"
`);
  const child = execFile("python3", ["-c", HERMES_SETTINGS_KEY_WORKER, "key"], { cwd: root, env: { PATH: process.env.PATH, PYTHONPATH: root }, timeout: 10000, maxBuffer: 4096 });
  child.stdin!.end(JSON.stringify({ provider: failure === "unknown_provider" ? "custom" : "anthropic", key: "fixture-secret-key" }));
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
    let stdout = "", stderr = "";
    child.stdout!.on("data", chunk => { stdout += chunk; }); child.stderr!.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => accept({ code, stdout, stderr }));
  });
  expect(result).toEqual({ code: 1, stdout: "", stderr: "" });
});
it("shutdown drains a native key connection already committing its exact route", async () => {
  const { createHermesSettingsConnection } = await import("../../packages/gateway/src/ai-providers/hermes-settings-auth.js");
  const root = await mkdtemp(join(tmpdir(), "hermes-key-drain-")); directories.push(root);
  const installation = join(root, ".hermes/hermes-agent");
  await mkdir(join(installation, "venv/bin"), { recursive: true }); await mkdir(join(installation, "hermes_cli"));
  await symlink(execFileSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim(), join(installation, "venv/bin/python"));
  await writeFile(join(installation, "hermes_cli/__init__.py"), "");
  await writeFile(join(installation, "hermes_cli/config.py"), `
values = {}
def require_env_writable(name, operation): pass
def save_env_value_secure(name, key):
    values[name] = key
    return {'success': True}
def get_env_value(name): return values.get(name)
`);
  let release!: () => void;
  const commit = new Promise<void>(accept => { release = accept; }); const enableConnected = vi.fn(() => commit);
  const connection = createHermesSettingsConnection({ homePath: root, enableConnected, fetchFn: async () => new Response(null, { status: 200 }) });
  try {
    expect(await connection.apiKeyProviders()).toEqual(["openai", "anthropic", "openrouter"]);
    const saving = connection.verifyKey({ harnessInstanceId: "hermes", providerId: "anthropic", apiKey: "synthetic-key" });
    await vi.waitFor(() => expect(enableConnected).toHaveBeenCalledWith("hermes", "anthropic", expect.any(String)));
    const closing = connection.close();
    expect(await Promise.race([closing.then(() => "closed"), new Promise(accept => setTimeout(() => accept("waiting"), 20))])).toBe("waiting");
    release(); await saving; await closing;
    expect(await connection.apiKeyProviders()).toEqual([]);
  } finally { release?.(); await connection.close(); }
});
