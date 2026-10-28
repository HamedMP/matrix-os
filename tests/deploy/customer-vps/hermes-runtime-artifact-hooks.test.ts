import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
const run = promisify(execFile);
const installerPath = "distro/customer-vps/host-bin/matrix-install-hermes";

it.each([{ recovery: false, code: 0 }, { recovery: false, code: 37 }, { recovery: true, code: 0 }, { recovery: true, code: 38 }])(
  "executes the isolated publication helper and propagates status: %j", async ({ recovery, code }) => {
    const installer = await readFile(installerPath, "utf8");
    const begin = installer.indexOf("run_hermes_artifact_helper() {");
    expect(begin).toBeGreaterThan(-1);
    const helper = installer.slice(begin, installer.indexOf("\n}\n", begin) + 3);
    const root = await mkdtemp("/tmp/eng306-artifact-hook-");
    try {
      await mkdir(join(root, "app/scripts"), { recursive: true });
      await writeFile(join(root, "app/scripts/publish-hermes-runtime.py"), `import os,sys,json\nfrom pathlib import Path\nPath(os.environ['HOME'],'invocation.json').write_text(json.dumps({'args':sys.argv[1:],'home':os.environ['HOME'],'hermes':os.environ['HERMES_HOME'],'isolated':sys.flags.isolated,'noBytecode':sys.dont_write_bytecode}))\nraise SystemExit(${code})\n`);
      const script = `set -eu\nMATRIX_RUNTIME_HOME="$1"\nHERMES_HOME="$1/.hermes"\nMATRIX_APP_DIR="$1/app"\nrun_installer_as_runtime_user() { "$@"; }\n${helper}\nrun_hermes_artifact_helper ${recovery ? "--recover" : ""}\nprintf success > "$1/success"\n`;
      let status = 0;
      try { await run("bash", ["-c", script, "fixture", root], { timeout: 10_000 }); }
      catch (error) { status = Number((error as { code: number }).code); }
      expect(status).toBe(code);
      const invocation = JSON.parse(await readFile(join(root, "invocation.json"), "utf8"));
      expect(invocation).toEqual({ args: [join(root, ".hermes/hermes-agent"), ...(recovery ? ["--recover"] : [])], home: root, hermes: join(root, ".hermes"), isolated: 1, noBytecode: true });
      if (code === 0) await expect(access(join(root, "success"))).resolves.toBeUndefined();
      else await expect(access(join(root, "success"))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  },
);

it("recovers before upstream writes and publishes only after dependency/setup reconciliation", async () => {
  const installer = await readFile(installerPath, "utf8");
  const recovery = installer.indexOf('run_hermes_artifact_helper --recover');
  const publish = installer.lastIndexOf('run_hermes_artifact_helper\n');
  expect(recovery).toBeGreaterThan(-1);
  expect(recovery).toBeGreaterThan(installer.indexOf('trap restore_hermes_dashboard EXIT'));
  expect(recovery).toBeLessThan(installer.indexOf('log "installing Hermes Agent'));
  expect(publish).toBeGreaterThan(installer.indexOf('pm install --extra anthropic --extra mcp'));
  expect(publish).toBeGreaterThan(installer.indexOf('"$MATRIX_APP_DIR/scripts/reconcile-agent-npm-prefix.mjs"\n'));
  expect(publish).toBeLessThan(installer.indexOf('log "Hermes and uv are installed"'));
});

it("ships an executable Python entry through the actual standard Host script-copy block", async () => {
  const builder = await readFile("scripts/build-host-bundle.sh", "utf8");
  const begin = builder.indexOf('mkdir -p "$STAGE_DIR/app/scripts"');
  const end = builder.indexOf('cp -a "$ROOT_DIR/skills"', begin);
  expect(begin).toBeGreaterThan(-1); expect(end).toBeGreaterThan(begin);
  const stage = await mkdtemp("/tmp/eng306-artifact-stage-");
  try {
    await run("bash", ["-c", builder.slice(begin, end)], { env: { ...process.env, ROOT_DIR: resolve("."), STAGE_DIR: stage }, timeout: 10_000 });
    const file = join(stage, "app/scripts/publish-hermes-runtime.py");
    expect(await readFile(file)).toEqual(await readFile("scripts/publish-hermes-runtime.py"));
    const result = await run("python3", ["-I", "-B", file, "--help"], { timeout: 10_000 });
    expect(result.stdout).toContain("--recover");
  } finally { await rm(stage, { recursive: true, force: true }); }
});
