import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("matrix terminal runtime host service", () => {
  it("runs a bounded control plane while user units own project Zellij processes", async () => {
    const unit = await readFile("distro/customer-vps/systemd/matrix-terminal-runtime.service", "utf8");
    const gateway = await readFile("distro/customer-vps/systemd/matrix-gateway.service", "utf8");
    const service = await readFile("packages/terminal-runtime/src/service.ts", "utf8");
    expect(unit).toContain("ExecStart=/opt/matrix/bin/matrix-terminal-runtime");
    expect(unit).toContain("Description=Matrix OS project terminal control plane");
    expect(unit).toContain("RuntimeDirectory=matrix");
    expect(unit).toContain("MemoryMax=");
    expect(unit).toContain("KillMode=control-group");
    expect(gateway).toMatch(/^After=.*\bmatrix-terminal-runtime\.service\b/m);
    expect(gateway).toMatch(/^Wants=.*\bmatrix-terminal-runtime\.service\b/m);
    expect(gateway).not.toMatch(/^Requires=.*\bmatrix-terminal-runtime\.service\b/m);
    expect(gateway).not.toContain("PartOf=matrix-terminal-runtime.service");
    expect(service).toContain("createUserSystemdTerminalRuntime");
    expect(service).toContain("createUserSystemdWorkspaceLifecycle");
    expect(unit).toContain("ConditionPathExists=/opt/matrix/app/TERMINAL_RUNTIME_GENERATION");
  });

  it("initializes Zellij assets before migration, including ExecStartPre migrate-only", async () => {
    const service = await readFile("packages/terminal-runtime/src/service.ts", "utf8");
    const initialize = service.indexOf("await initializeMatrixZellijConfig(homePath)");
    expect(initialize).toBeGreaterThan(-1);
    expect(initialize).toBeLessThan(service.indexOf("await migrateTerminalWorkspaces("));
    expect(initialize).toBeLessThan(service.indexOf('if (mode === "--migrate-only") return'));
    expect(initialize).toBeLessThan(service.indexOf("await runtime.restoreAll()"));
  });

  it("installs and reloads static user units without stopping live workspaces", async () => {
    const installer = await readFile("scripts/install-server.sh", "utf8");
    expect(installer).toContain("/opt/matrix/user-systemd/matrix-zellij@.service");
    expect(installer).toContain("/opt/matrix/user-systemd/matrix-terminal.slice");
    expect(installer).toContain("systemctl --user daemon-reload");
    expect(installer).not.toMatch(/systemctl (?:stop|restart)[^\n]*(?:matrix-zellij@|matrix-terminal\.slice|user@)/);
  });

  it("pins the coordinated host runtimes to Zellij 0.44.3", async () => {
    const files = await Promise.all([
      readFile("scripts/build-host-bundle.sh", "utf8"),
      readFile("Dockerfile", "utf8"),
      readFile("Dockerfile.dev", "utf8"),
    ]);
    for (const file of files) expect(file).toContain("0.44.3");
    for (const file of files) expect(file).not.toContain("0.44.1");
  });

  it("exits immediately on fatal startup and exposes an actual socket readiness probe", async () => {
    const service = await readFile("packages/terminal-runtime/src/service.ts", "utf8");
    expect(service).toContain('if (mode === "--health-check")');
    expect(service).toContain("await client.listWorkspaces()");
    expect(service).toContain("process.exit(1)");
    expect(service).not.toContain("process.exitCode = 1");
  });

  it("ships compiled terminal runtime entrypoints before building the gateway", async () => {
    const [runtimePackageSource, gatewayPackageSource] = await Promise.all([
      readFile(new URL("../../packages/terminal-runtime/package.json", import.meta.url), "utf8"),
      readFile(new URL("../../packages/gateway/package.json", import.meta.url), "utf8"),
    ]);
    const runtimePackage = JSON.parse(runtimePackageSource) as {
      exports: Record<string, { types: string; development: string; default: string }>;
    };
    const gatewayPackage = JSON.parse(gatewayPackageSource) as { scripts: { build: string } };

    expect(runtimePackage.exports["."]).toEqual({
      types: "./src/index.ts",
      development: "./src/index.ts",
      default: "./dist/index.js",
    });
    expect(runtimePackage.exports["./zellij-config"]?.development)
      .toBe("./src/zellij-config.ts");
    expect(runtimePackage.exports["./zellij-config"]?.default)
      .toBe("./dist/zellij-config.js");
    await expect(readFile(new URL(
      `../../packages/terminal-runtime/${runtimePackage.exports["./zellij-config"]!.development.slice(2)}`,
      import.meta.url,
    ), "utf8")).resolves.toContain("renderMatrixZellijConfig");
    const runtimeCwd = new URL("../../packages/terminal-runtime/", import.meta.url);
    const development = await execFileAsync(process.execPath, [
      "--conditions=development",
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      "const value = await import('@matrix-os/terminal-runtime/zellij-config'); process.stdout.write(typeof value.renderMatrixZellijConfig)",
    ], { cwd: runtimeCwd });
    expect(development.stdout).toBe("function");
    const production = await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      "process.stdout.write(import.meta.resolve('@matrix-os/terminal-runtime/zellij-config'))",
    ], { cwd: runtimeCwd });
    expect(production.stdout).toMatch(/\/dist\/zellij-config\.js$/);
    expect(runtimePackage.exports["./user-systemd-capacity"]?.development)
      .toBe("./src/user-systemd-capacity.ts");
    expect(runtimePackage.exports["./user-systemd-capacity"]?.default)
      .toBe("./dist/user-systemd-capacity.js");
    expect(runtimePackage.exports["./user-systemd-readiness"]?.development)
      .toBe("./src/user-systemd-readiness.ts");
    expect(runtimePackage.exports["./user-systemd-readiness"]?.default)
      .toBe("./dist/user-systemd-readiness.js");
    expect(runtimePackage.exports["./user-systemd-controller"]?.development)
      .toBe("./src/user-systemd-controller.ts");
    expect(runtimePackage.exports["./user-systemd-controller"]?.default)
      .toBe("./dist/user-systemd-controller.js");
    expect(gatewayPackage.scripts.build.indexOf("@matrix-os/terminal-runtime"))
      .toBeLessThan(gatewayPackage.scripts.build.indexOf("tsc"));
  });
});
