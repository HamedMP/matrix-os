import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";
import { BuildOrchestrator } from "../../packages/gateway/src/app-runtime/build-orchestrator.js";

it("ships pinned pnpm through first install and an app-only update for gateway builds", async () => {
  const repo = process.cwd();
  const bundleScript = readFileSync(join(repo, "scripts/build-host-bundle.sh"), "utf8");
  // The production bundle producer must invoke the same staging operation as this test.
  expect(bundleScript).toContain('bash "$ROOT_DIR/scripts/stage-host-pnpm.sh" "$STAGE_DIR"');
  const gatewayLauncher = readFileSync(join(repo, "distro/customer-vps/host-bin/matrix-gateway"), "utf8");
  expect(gatewayLauncher).toContain('matrix_prepend_path_once "/opt/matrix/app/bin"');
  const updater = readFileSync(join(repo, "distro/customer-vps/host-bin/matrix-sync-agent"), "utf8");
  expect(updater).toContain('sudo mv "$extract_dir/app" "$APP_DIR"');

  const fixture = mkdtempSync(join(tmpdir(), "matrix-host-pnpm-"));
  const stage = join(fixture, "stage");
  const installed = join(fixture, "installed");
  const appDir = join(fixture, "new-app");
  const originalPath = process.env.PATH;
  try {
    mkdirSync(join(stage, "runtime/node/bin"), { recursive: true });
    mkdirSync(join(stage, "runtime/node/lib/node_modules"), { recursive: true });
    mkdirSync(join(stage, "app"), { recursive: true });
    mkdirSync(installed);
    symlinkSync(process.execPath, join(stage, "runtime/node/bin/node"));

    const staged = spawnSync("bash", [join(repo, "scripts/stage-host-pnpm.sh"), stage], {
      cwd: repo,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(staged.status, staged.stderr || staged.stdout).toBe(0);

    renameSync(join(stage, "runtime"), join(installed, "runtime"));
    renameSync(join(stage, "app"), join(installed, "app"));
    const pinned = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).packageManager.split("@")[1];
    const buildPath = [join(installed, "app/bin"), join(installed, "runtime/node/bin"), "/usr/bin", "/bin"].join(delimiter);
    const version = spawnSync("sh", ["-c", "pnpm --version"], { env: { PATH: buildPath }, encoding: "utf8" });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(pinned);
    expect(existsSync(join(installed, "runtime/node/bin/pnpm"))).toBe(true);
    expect(readlinkSync(join(installed, "runtime/node/bin/pnpm"))).toBe("../lib/node_modules/pnpm/bin/pnpm.cjs");
    expect(readlinkSync(join(installed, "app/bin/pnpm"))).toBe("../tools/pnpm/bin/pnpm.cjs");

    // Upgrades replace app/ but retain runtime/node. A fresh app must still use
    // the pinned executable from the replacement app payload, even when the
    // older installed runtime never had pnpm.
    rmSync(join(installed, "runtime/node/bin/pnpm"));
    rmSync(join(installed, "runtime/node/lib/node_modules/pnpm"), { recursive: true });
    const update = join(fixture, "update");
    mkdirSync(join(update, "runtime/node/bin"), { recursive: true });
    mkdirSync(join(update, "runtime/node/lib/node_modules"), { recursive: true });
    mkdirSync(join(update, "app"), { recursive: true });
    symlinkSync(process.execPath, join(update, "runtime/node/bin/node"));
    const updated = spawnSync("bash", [join(repo, "scripts/stage-host-pnpm.sh"), update], {
      cwd: repo,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(updated.status, updated.stderr || updated.stdout).toBe(0);
    rmSync(join(installed, "app"), { recursive: true });
    renameSync(join(update, "app"), join(installed, "app"));

    cpSync(join(repo, "tests/fixtures/apps/hello-vite"), appDir, { recursive: true });
    const manifestPath = join(appDir, "matrix.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.build.install = "pnpm install --frozen-lockfile";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    process.env.PATH = buildPath;
    const result = await new BuildOrchestrator({ concurrency: 1, storeDir: join(fixture, "store") }).build("new-app", appDir);
    expect(result, existsSync(join(appDir, ".build.log")) ? readFileSync(join(appDir, ".build.log"), "utf8") : "no build log").toMatchObject({ ok: true });
    expect(existsSync(join(appDir, "dist/index.html"))).toBe(true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(fixture, { recursive: true, force: true });
  }
}, 180_000);
