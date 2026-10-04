import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
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
