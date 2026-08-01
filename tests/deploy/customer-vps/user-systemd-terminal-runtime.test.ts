import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("customer VPS user-systemd terminal runtime", () => {
  const root = process.cwd();

  it("installs a non-enabled per-runtime user unit with bounded resource ownership", () => {
    const unit = readFileSync(
      join(root, "distro/customer-vps/systemd-user/matrix-zellij@.service"),
      "utf8",
    );
    const slice = readFileSync(
      join(root, "distro/customer-vps/systemd-user/matrix-terminal.slice"),
      "utf8",
    );

    expect(unit).toContain("ExecStart=/opt/matrix/runtime/node/bin/node /opt/matrix/terminal-runtime/current/matrix-terminal-user-keeper.mjs %i");
    expect(unit).toContain("ConditionPathExists=/home/matrix/home/system/terminal-runtimes/%i.json");
    expect(unit).toContain("Environment=MATRIX_HOME=/home/matrix/home");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("Restart=no");
    expect(unit).toContain("Slice=matrix-terminal.slice");
    expect(unit).toContain("TasksMax=");
    expect(unit).not.toContain("WantedBy=");
    expect(unit).not.toContain("Restart=always");
    expect(slice).toContain("MemoryMax=");
    expect(slice).toContain("TasksMax=");
  });

  it("keeps command argv out of the descriptor-to-keeper boundary", () => {
    const keeper = readFileSync(
      join(root, "distro/customer-vps/host-bin/matrix-terminal-user-keeper.mjs"),
      "utf8",
    );

    expect(keeper).toContain("runtimeId");
    expect(keeper).toContain("layoutPath");
    expect(keeper).toContain("generation");
    expect(keeper).toContain("/usr/bin/script");
    expect(keeper).toContain("--new-session-with-layout");
    expect(keeper).not.toContain("descriptor.command");
    expect(keeper).not.toContain("descriptor.args");
    expect(keeper).not.toContain("eval(");
  });

  it("ships immutable helper/Zellij generations and globally installed user units", () => {
    const build = readFileSync(join(root, "scripts/build-host-bundle.sh"), "utf8");
    const cloudInit = readFileSync(join(root, "distro/customer-vps/cloud-init.yaml"), "utf8");

    expect(build).toContain('"$STAGE_DIR/terminal-runtime/generations/$TERMINAL_RUNTIME_GENERATION"');
    expect(build).toContain('"$STAGE_DIR/user-systemd"');
    expect(build).toContain("TERMINAL_RUNTIME_GENERATION");
    expect(build).toContain("matrix-terminal-attach.mjs");
    expect(build).toContain("bin app runtime systemd user-systemd terminal-runtime release.json");
    expect(cloudInit).toContain("/etc/systemd/user");
    expect(cloudInit).toContain("systemctl --user daemon-reload");
    expect(cloudInit).toContain("loginctl enable-linger matrix");
  });

  it("keeps the production adapter dormant behind one exact activation flag", () => {
    const server = readFileSync(join(root, "packages/gateway/src/server.ts"), "utf8");

    expect(server).toContain('process.env.MATRIX_TERMINAL_USER_SYSTEMD_ENABLED === "1"');
    expect(server).toContain("loadInstalledTerminalRuntimeGeneration");
    expect(server).toContain("createUserSystemdZellijRuntime");
    expect(server).toContain("createUserSystemdZellijAdapter");
    expect(server).not.toContain('MATRIX_TERMINAL_USER_SYSTEMD_ENABLED !== "0"');
  });

  it("installs a fixed attach helper that resolves each descriptor-pinned generation", () => {
    const attach = readFileSync(
      join(root, "distro/customer-vps/host-bin/matrix-terminal-attach.mjs"),
      "utf8",
    );
    const updater = readFileSync(
      join(root, "distro/customer-vps/host-bin/matrix-sync-agent"),
      "utf8",
    );

    expect(attach).toContain("descriptor.generation");
    expect(attach).toContain('["attach", descriptor.sessionName, ...remainingArgs]');
    expect(attach).not.toContain("shell: true");
    expect(updater).toContain("/usr/local/bin/matrix-terminal-attach");
  });

  it("updates and rolls back the current generation without stopping user terminal units", () => {
    const updater = readFileSync(
      join(root, "distro/customer-vps/host-bin/matrix-sync-agent"),
      "utf8",
    );
    const generationGc = readFileSync(
      join(root, "distro/customer-vps/host-bin/matrix-terminal-generation-gc.py"),
      "utf8",
    );

    expect(updater).toContain("install_terminal_runtime_payload");
    expect(updater).toContain("activate_terminal_runtime_generation");
    expect(updater).toContain("cleanup_terminal_runtime_generations");
    expect(updater).toContain("TERMINAL_RUNTIME_MAX_GENERATIONS");
    expect(updater).toContain("TERMINAL_RUNTIME_GENERATION");
    expect(updater).toContain("system/terminal-runtimes");
    expect(updater).toContain("matrix-terminal-generation-gc.py");
    expect(generationGc).toContain("entry.is_symlink()");
    expect(updater).toContain("terminal runtime generation cap reached by active or recoverable sessions");
    expect(updater).not.toMatch(/systemctl stop[^\n]*(matrix-zellij|matrix-terminal\.slice|user@)/);
    expect(updater).not.toMatch(/systemctl restart[^\n]*(matrix-zellij|matrix-terminal\.slice|user@)/);
  });

  it("gates exact-head disposable-VPS acceptance behind an explicit same-repository label", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/user-systemd-terminal-production-acceptance.yml"),
      "utf8",
    );

    expect(workflow).toContain("github.event.label.name == 'user-systemd-production-acceptance'");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).toContain('any(.name == "preview-vps")');
    expect(workflow).toContain('any(.name == "user-systemd-production-acceptance")');
    expect(workflow).toContain("ref: ${{ needs.gate.outputs.head }}");
    expect(workflow).toContain("--channel none");
    expect(workflow).not.toMatch(/--channel\s+(dev|canary|beta|stable)/);
  });

  it("requires two immutable bundles and the complete dormant-runtime host matrix", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/user-systemd-terminal-production-acceptance.yml"),
      "utf8",
    );
    const acceptance = readFileSync(
      join(root, "scripts/spikes/user-systemd-terminal/production-acceptance.sh"),
      "utf8",
    );
    const probe = readFileSync(
      join(root, "scripts/spikes/user-systemd-terminal/production-probe.mjs"),
      "utf8",
    );

    expect(workflow).toContain("Build two exact-head user-systemd acceptance bundles");
    expect(workflow).toContain('for suffix in a b; do');
    expect(workflow).toContain("MATRIX_TERMINAL_USER_SYSTEMD_ENABLED=1");
    expect(acceptance).toContain("gatewayRestartPreservesRuntimes");
    expect(acceptance).toContain("gatewaySigkillPreservesRuntimes");
    expect(acceptance).toContain("bundleOnePreservesRuntimes");
    expect(acceptance).toContain("bundleTwoPreservesRuntimes");
    expect(acceptance).toContain("rollbackPreservesRuntimes");
    expect(acceptance).toContain("detachPreservesRuntimes");
    expect(acceptance).toContain("browserAttachmentPtysRemainGatewayOwned");
    expect(acceptance).toContain("gatewayMemoryIsolation");
    expect(acceptance).toContain("deleteRemovesExactRuntime");
    expect(acceptance).toContain("deleteIsIdempotent");
    expect(acceptance).toContain("deleteRemovesSocketAndSnapshots");
    expect(acceptance).toContain("corruptAndSymlinkStateFailsClosed");
    expect(acceptance).toContain("invalidRuntimeIdsFailClosed");
    expect(acceptance).toContain("conflictingDescriptorReuseFailsClosed");
    expect(acceptance).toContain("staleInactiveStateIsRecoverable");
    expect(acceptance).toContain("hostileDescriptorFieldsFailClosed");
    expect(acceptance).toContain("generationGcIsReferenceAndSymlinkSafe");
    expect(acceptance).toContain("generationRetentionIsBounded");
    expect(acceptance).toContain("newRuntimesUseCurrentGeneration");
    expect(acceptance).toContain("postRollbackRuntimeUsesCompatibleGeneration");
    expect(acceptance).toContain("resourceControlsEffective");
    expect(acceptance).toContain("resourceLimitIsolatesFailure");
    expect(acceptance).toContain("rebootStartsNoRuntime");
    expect(acceptance).toContain("rebootCreatesNoReplacementPids");
    expect(acceptance).toContain("rebootProducesNoOutput");
    expect(probe).toContain("/ws/terminal");
    expect(acceptance).toContain("MemoryCurrent");
    expect(acceptance).toContain("cgroup.controllers");
    expect(acceptance).toContain("list-sessions");
    expect(probe).toContain("matrix-zellij@");
    expect(probe).toContain("ControlGroup");
    expect(probe).toContain("MemoryMax");
    expect(probe).toContain("TasksMax");
    expect(acceptance).toContain("write_progress");
    expect(acceptance).toContain('write_state "failed:${current_progress}"');
    expect(acceptance).toContain("write_progress runtime-shell-create");
    expect(acceptance).toContain("write_progress runtime-agent-create");
    expect(acceptance).toContain("write_progress runtime-shell-snapshot");
    expect(acceptance).toContain("write_progress runtime-agent-snapshot");
    expect(acceptance).toContain('/usr/bin/timeout --signal=KILL 15');
    expect(acceptance).toContain("failed:phase-worker-exited:");
    expect(acceptance).toContain("deadline=$((SECONDS + 1800))");
    expect(acceptance).not.toContain("for _ in $(seq 1 1800)");
    expect(workflow).toContain("Acceptance stalled at ${state:-unavailable}");
    expect(workflow).toContain("Acceptance failed at ${state}");
    expect(workflow).toContain("progress_deadline=$((SECONDS + progress_timeout))");
    expect(workflow).toContain("Acceptance phase stalled at ${state}");
  });

  it("rejects permissive descriptor parsers and pins the keeper helper to the descriptor generation", () => {
    const keeper = readFileSync(
      join(root, "distro/customer-vps/host-bin/matrix-terminal-user-keeper.mjs"),
      "utf8",
    );
    const attach = readFileSync(
      join(root, "distro/customer-vps/host-bin/matrix-terminal-attach.mjs"),
      "utf8",
    );
    const unit = readFileSync(
      join(root, "distro/customer-vps/systemd-user/matrix-zellij@.service"),
      "utf8",
    );

    expect(keeper).toContain("DESCRIPTOR_KEYS");
    expect(attach).toContain("DESCRIPTOR_KEYS");
    expect(keeper).not.toMatch(/\}\s*catch\s*\{/);
    expect(attach).not.toMatch(/\}\s*catch\s*\{/);
    expect(keeper).toContain("pinnedKeeperPath");
    expect(keeper).toContain('"generations", descriptor.generation, "matrix-terminal-user-keeper.mjs"');
    expect(unit).toContain("/terminal-runtime/current/matrix-terminal-user-keeper.mjs");
  });
});
