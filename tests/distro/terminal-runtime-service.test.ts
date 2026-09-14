import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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
});
