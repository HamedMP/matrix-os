import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("dormant scope runtime host bundle", () => {
  it("installs a least-privilege system supervisor that is fenced by the app marker", async () => {
    const unit = await readFile("distro/customer-vps/systemd/matrix-scope-runtime.service", "utf8");
    expect(unit).toContain("User=root");
    expect(unit).toContain("Group=matrix");
    expect(unit).toContain("ConditionPathExists=!/opt/matrix/app/SCOPE_RUNTIME_DISABLED");
    expect(unit).toContain("RuntimeDirectory=matrix-scope-runtime");
    expect(unit).toContain("RuntimeDirectoryPreserve=yes");
    expect(unit).toContain("RuntimeDirectoryMode=0770");
    expect(unit).toContain("StateDirectory=matrix-scope-runtime");
    expect(unit).toContain("PrivateNetwork=yes");
    expect(unit).toContain("ProtectHome=tmpfs");
    // Only fixed workload roots are visible to the supervisor for mount validation.
    expect(unit.match(/^(?:Bind|BindReadOnly|ReadWrite)Paths=.*$/gm)).toEqual([
      "BindReadOnlyPaths=-/home/matrix/home/bots",
      "BindReadOnlyPaths=-/home/matrix/home/agent-workspaces",
      "BindReadOnlyPaths=-/home/matrix/home/projects",
      "BindReadOnlyPaths=-/home/matrix/home/worktrees",
    ]);
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("NoNewPrivileges=yes");
    expect(unit).toContain("CapabilityBoundingSet=");
    expect(unit).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(unit).not.toContain("EnvironmentFile=");
    const gatewayUnit = await readFile("distro/customer-vps/systemd/matrix-gateway.service", "utf8");
    expect(gatewayUnit).toMatch(/^Wants=(?:\S+\s+)*matrix-scope-runtime\.service(?:\s+\S+)*$/m);
    expect(gatewayUnit).toMatch(/After=.*matrix-scope-runtime\.service/);
  });

  it("builds and starts the supervisor before gateway while policy keeps M2 independently gated", async () => {
    const build = await readFile("scripts/build-host-bundle.sh", "utf8");
    const cloudInit = await readFile("distro/customer-vps/cloud-init.yaml", "utf8");
    const updater = await readFile("distro/customer-vps/host-bin/matrix-sync-agent", "utf8");
    const wrapper = await readFile("distro/customer-vps/host-bin/matrix-scope-runtime", "utf8");

    expect(build).toContain("pnpm --filter '@matrix-os/scope-runtime' build");
    expect(build).not.toContain('printf \'1\\n\' > "$STAGE_DIR/app/SCOPE_RUNTIME_DISABLED"');
    expect(build).toContain('"$STAGE_DIR/bin/matrix-scope-runtime"');
    expect(wrapper).toContain("packages/scope-runtime/dist/main.js");
    expect(cloudInit).toMatch(/systemctl enable[^\n]*matrix-scope-runtime/);
    expect(cloudInit).toMatch(/systemctl start[^\n]*matrix-scope-runtime/);
    expect(updater).toMatch(/systemctl enable[^\n]*matrix-scope-runtime/);
    expect(updater).toMatch(/systemctl start[^\n]*matrix-scope-runtime/);
    expect(updater).toContain("systemctl cat matrix-scope-runtime.service");
    expect(updater).toContain('runtime_services+=(matrix-scope-runtime)');
    expect(updater).toContain('systemctl stop "${runtime_services[@]}"');
  });

  it("builds the bundled bot worker, mounts it read-only, and prepares the bot root before the supervisor", async () => {
    const build = await readFile("scripts/build-host-bundle.sh", "utf8");
    const main = await readFile("packages/scope-runtime/src/main.ts", "utf8");
    const botPackage = JSON.parse(await readFile("packages/bot-runtime/package.json", "utf8")) as { scripts: Record<string, string> };
    const botProfile = await readFile("packages/scope-runtime/src/bot-profile.ts", "utf8");
    const cloudInit = await readFile("distro/customer-vps/cloud-init.yaml", "utf8");
    const updater = await readFile("distro/customer-vps/host-bin/matrix-sync-agent", "utf8");

    expect(build.indexOf("pnpm --filter '@matrix-os/bot-runtime' build"))
      .toBeGreaterThan(build.indexOf("pnpm --filter '@matrix-os/scope-runtime' build"));
    expect(botPackage.scripts.build).toContain("dist/bot-worker.mjs");
    expect(main).toContain('botRuntimeDirectory: "/opt/matrix/app/packages/bot-runtime/dist"');
    expect(botProfile).toContain("BindReadOnlyPaths=${BOT_RUNTIME_DIRECTORY_TOKEN}:${BOT_RUNTIME_MOUNT}");
    expect(cloudInit).toMatch(/install -d -o matrix -g matrix -m 0750 [^\n]*\/home\/matrix\/home\/bots/);
    expect(updater).toContain('for workload_root in /home/matrix/home/bots /home/matrix/home/agent-workspaces /home/matrix/home/projects /home/matrix/home/worktrees; do');
    expect(updater).toContain('if [ ! -d "$workload_root" ]; then');
    expect(updater.indexOf('sudo install -d -o matrix -g matrix -m 0750 "$workload_root"'))
      .toBeLessThan(updater.indexOf("sudo systemctl start matrix-scope-runtime.service"));
    for (const directory of ["agent-workspaces", "projects", "worktrees"]) {
      expect(cloudInit).toMatch(new RegExp(`install -d -o matrix -g matrix -m 0750 [^\\n]*/home/matrix/home/${directory}`));
      const prepared = updater.indexOf(`/home/matrix/home/${directory}`, updater.indexOf('if [ -f "$extract_dir/systemd/matrix-scope-runtime.service" ]'));
      expect(prepared).toBeGreaterThan(-1);
      expect(prepared).toBeLessThan(updater.indexOf("sudo systemctl start matrix-scope-runtime.service"));
    }
  });
});
