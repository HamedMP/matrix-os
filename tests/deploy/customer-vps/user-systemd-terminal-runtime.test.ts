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

  it("creates runtimes detached and keeps them alive with a non-sizing watcher", () => {
    const keeper = readFileSync(
      join(root, "distro/customer-vps/host-bin/matrix-terminal-user-keeper.mjs"),
      "utf8",
    );

    expect(keeper).toContain("runtimeId");
    expect(keeper).toContain("layoutPath");
    expect(keeper).toContain("generation");
    expect(keeper).toContain("/usr/bin/script");
    expect(keeper).toContain("--new-session-with-layout");
    expect(keeper).toContain('"attach", "--create-background", descriptor.sessionName');
    expect(keeper).toContain('"watch", descriptor.sessionName');
    expect(keeper).toContain("SESSION_START_TIMEOUT_MS");
    expect(keeper).toContain('process.off("SIGTERM", handleSigterm)');
    expect(keeper).toContain('process.off("SIGINT", handleSigint)');
    expect(keeper).not.toContain('"--session",');
    expect(keeper).not.toContain("descriptor.command");
    expect(keeper).not.toContain("descriptor.args");
    expect(keeper).not.toContain("eval(");
  });

  it("keeps awaited readiness retries alive for one-shot controller callers", () => {
    const controller = readFileSync(
      join(root, "packages/gateway/src/shell/user-systemd-terminal-runtime.ts"),
      "utf8",
    );

    expect(controller).toContain("await delay(READINESS_INTERVAL_MS)");
    expect(controller).not.toContain("timer.unref");
  });

  it("ships immutable helper/Zellij generations and globally installed user units", () => {
    const build = readFileSync(join(root, "scripts/build-host-bundle.sh"), "utf8");
    const cloudInit = readFileSync(join(root, "distro/customer-vps/cloud-init.yaml"), "utf8");
    const sizingSmoke = readFileSync(
      join(root, "scripts/smoke-zellij-watcher-sizing.mjs"),
      "utf8",
    );

    expect(build).toContain('"$STAGE_DIR/terminal-runtime/generations/$TERMINAL_RUNTIME_GENERATION"');
    expect(build).toContain('"$STAGE_DIR/user-systemd"');
    expect(build).toContain("TERMINAL_RUNTIME_GENERATION");
    expect(build).toContain("matrix-terminal-generation-id");
    expect(build).toContain("matrix-terminal-attach.mjs");
    expect(build).toContain("smoke-zellij-watcher-sizing.mjs");
    expect(sizingSmoke).toContain('spawn(zellijBinary, ["watch", sessionName]');
    expect(sizingSmoke).toContain("const INITIAL_SIZE = { cols: 160, rows: 60 }");
    expect(sizingSmoke).toContain("interactive.resize(RESIZED_SIZE.cols, RESIZED_SIZE.rows)");
    expect(build).toContain("bin app runtime systemd user-systemd terminal-runtime release.json");
    expect(cloudInit).toContain("/etc/systemd/user");
    expect(cloudInit).toContain("systemctl --user daemon-reload");
    expect(cloudInit).toContain("loginctl enable-linger matrix");
  });

  it("makes the restore database directory writable by the matrix service user", () => {
    const cloudInit = readFileSync(join(root, "distro/customer-vps/cloud-init.yaml"), "utf8");

    expect(cloudInit).toContain(
      "/var/lib/matrix/db /var/lib/matrix/db/snapshots",
    );
  });

  it("derives terminal generation IDs from bytes rather than staging paths", () => {
    const generationId = readFileSync(
      join(root, "distro/customer-vps/host-bin/matrix-terminal-generation-id"),
      "utf8",
    );

    expect(generationId).toContain("sha256sum \"$asset\" | awk '{print $1}'");
    expect(generationId).toContain("sha256sum | awk '{print \"gen_\" $1}'");
    expect(generationId).not.toContain("sha256sum \"$@\"");
  });

  it("activates the project-scoped runtime as a host service outside the gateway", () => {
    const server = readFileSync(join(root, "packages/gateway/src/server.ts"), "utf8");
    const build = readFileSync(join(root, "scripts/build-host-bundle.sh"), "utf8");
    const service = readFileSync(
      join(root, "distro/customer-vps/systemd/matrix-terminal-runtime.service"),
      "utf8",
    );

    expect(server).toContain("new TerminalRuntimeSocketClient");
    expect(server).toContain("process.env.MATRIX_TERMINAL_RUNTIME_SOCKET");
    expect(server).not.toContain("resolveUserSystemdTerminalActivation");
    expect(server).not.toContain("process.env.MATRIX_TERMINAL_USER_SYSTEMD_ENABLED");
    expect(server).toContain('const terminalAcceptanceEnabled = /^pr-[1-9][0-9]{0,9}$/.test(runtimeHandle)');
    expect(server).toContain('process.env.MATRIX_RUNTIME_SLOT === runtimeHandle');
    expect(server).toContain('secret: () => process.env.UPGRADE_TOKEN ?? ""');
    expect(build).toContain('cp -a "$ROOT_DIR/distro/customer-vps/systemd/." "$STAGE_DIR/systemd/"');
    expect(build).toContain("matrix-terminal-runtime");
    expect(service).toContain("User=matrix");
    expect(service).toContain("RuntimeDirectory=matrix");
    expect(service).toContain("ExecStart=/opt/matrix/bin/matrix-terminal-runtime");
    expect(service).toContain("KillMode=control-group");
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
    const decision = readFileSync(
      join(root, "specs/109-persist-terminal-sessions/user-systemd-alternative.md"),
      "utf8",
    );

    expect(updater).toContain("install_terminal_runtime_payload");
    expect(updater).toContain('if ! install_terminal_runtime_payload "$extract_dir"; then');
    expect(updater).toContain("Terminal runtime installation failed; aborting before app replacement");
    expect(updater.indexOf('if ! install_terminal_runtime_payload "$extract_dir"; then')).toBeLessThan(
      updater.indexOf('sudo mv "$extract_dir/app" "$APP_DIR"'),
    );
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
    expect(decision).toContain("ordered content digests");
    expect(decision).toContain("exact-version reapply");
  });

  it("documents separate fail-closed rollout paths for new and existing VPSes", () => {
    const activation = readFileSync(
      join(root, "docs/dev/user-systemd-terminal-activation.md"),
      "utf8",
    );
    const decision = readFileSync(
      join(root, "specs/109-persist-terminal-sessions/user-systemd-alternative.md"),
      "utf8",
    );

    expect(activation).toContain("Activation never falls back to the legacy");
    expect(activation).toContain("### New signups");
    expect(activation).toContain("### Existing users");
    expect(activation).toContain("two-stage migration");
    expect(activation).toContain("commits `/opt/matrix/release.json` only after health succeeds");
    expect(activation).toContain("active `/opt/matrix/app/BUNDLE_VERSION`");
    expect(decision).toContain("A direct jump to activation is intentionally rejected and rolled back");
    expect(decision).toContain("it never falls back to the legacy terminal owner");
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
    const rebootVerification = workflow.slice(
      workflow.indexOf("- name: Verify zero automatic execution after reboot"),
    );
    const acceptance = readFileSync(
      join(root, "scripts/spikes/user-systemd-terminal/production-acceptance.sh"),
      "utf8",
    );
    const prepareOperation = acceptance.slice(
      acceptance.indexOf("  prepare)"),
      acceptance.indexOf("  launch)"),
    );
    const prepareWorker = acceptance.slice(
      acceptance.indexOf("prepare_exact_head_runtime()"),
      acceptance.indexOf("create_hostile_state()"),
    );
    const probe = readFileSync(
      join(root, "scripts/spikes/user-systemd-terminal/production-probe.mjs"),
      "utf8",
    );

    expect(workflow).toContain("Build two exact-head user-systemd acceptance bundles");
    expect(workflow).toContain('for suffix in a b; do');
    expect(workflow).toContain("MATRIX_TERMINAL_USER_SYSTEMD_ENABLED=1");
    expect(workflow).toContain('"${remote_base}.sh" helper root 0700');
    expect(workflow).toContain('"${remote_base}-probe.mjs" probe matrix 0640');
    expect(workflow).toContain('--arg group "$group" --arg mode "$mode"');
    expect(workflow).toContain("x-matrix-acceptance-timestamp");
    expect(workflow).toContain("x-matrix-acceptance-nonce");
    expect(workflow).toContain("x-matrix-acceptance-signature");
    expect(workflow).toContain("x-matrix-acceptance-response-signature");
    expect(workflow).not.toContain('authorization: Bearer ${token}');
    expect(workflow).not.toContain('"$response" <<\'NODE\'');
    expect(rebootVerification).toContain(
      'if ! send_signed_command "$body" "$response"; then',
    );
    expect(rebootVerification).toContain('return 1');
    expect(rebootVerification).toContain('grep -q \'^reboot-ready$\' <<<"$state"');
    expect(acceptance).toContain("gatewayRestartPreservesRuntimes");
    expect(acceptance).toContain("gatewaySigkillPreservesRuntimes");
    expect(acceptance).toContain("metadataRenamePreservesRuntime");
    expect(acceptance).toContain('rename_session "$shell_name" "$renamed_shell_name"');
    expect(acceptance).toContain('roles_match "$renamed_shell_name" shell "$shell_baseline"');
    expect(workflow).toContain('"metadataRenamePreservesRuntime"');
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
    expect(acceptance).toContain("write_progress reboot-user-bus-ready");
    expect(acceptance).toContain("for role in shell agent; do");
    for (const rebootStage of [
      "unit-inactive",
      "unit-never-started",
      "cgroup-empty",
      "descriptor-retained",
      "old-pids-detached",
    ]) {
      expect(acceptance).toContain(`write_progress "reboot-\${role}-${rebootStage}"`);
    }
    expect(acceptance).toContain('--property=ExecMainStartTimestampMonotonic');
    expect(acceptance).toContain('--property=ActiveEnterTimestampMonotonic');
    expect(acceptance).toContain('[ "$exec_start_state" = zero ]');
    expect(acceptance).toContain('[ "$active_enter_state" = zero ]');
    expect(acceptance).toContain('cgroup_state="$(cgroup_tree_state "$old_cgroup")"');
    expect(acceptance).toContain('events="${root}/cgroup.events"');
    expect(acceptance).toContain('/usr/bin/timeout --kill-after=1s 5s /usr/bin/python3 - "$events"');
    expect(acceptance).toContain('os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW');
    expect(acceptance).toContain('data = os.read(events_fd, 1024)');
    expect(acceptance).toContain('done <<<"$events_data"');
    expect(acceptance).toContain('[ "${#events_data}" -lt 1024 ]');
    expect(acceptance).toContain('current_failure="cgroup-${cgroup_state}"');
    expect(acceptance).toContain('[[ "$cgroup_state" =~ ^(absent|empty)$ ]]');
    expect(acceptance).not.toContain('case "$cgroup_state" in');
    expect(acceptance).toContain('absent|empty)');
    expect(acceptance).toContain('echo populated');
    expect(acceptance).toContain('echo invalid-events');
    expect(acceptance).not.toContain('done <"$events"');
    expect(acceptance).toContain('readonly phase2_unit="matrix-user-systemd-accept-${head_sha:0:7}-${run_nonce}-phase2.service"');
    expect(acceptance).toContain('[[ "$state" == phase2-running:* ]] && ! systemctl is-active --quiet "$phase2_unit"');
    expect(acceptance).toContain('--property=RuntimeMaxSec=120');
    expect(acceptance).not.toContain('find "$root" -xdev -name cgroup.procs');
    expect(acceptance).toContain(
      'matrix\\.slice/matrix-terminal\\.slice/matrix-zellij@rt_[0-9a-f]{32}\\.service$',
    );
    expect(acceptance).toContain('reboot_output_size_file="${state_root}/reboot-output-size"');
    expect(acceptance).toContain('reboot_boot_id_file="${state_root}/reboot-boot-id"');
    expect(acceptance).toContain('"$helper_path" reboot-now "$head_sha" "$run_nonce" "$preview_version"');
    expect(acceptance).toContain('cat /proc/sys/kernel/random/boot_id');
    expect(acceptance).toContain('write_progress reboot-boot-changed');
    expect(acceptance).toContain('[ "$boot_id_after" != "$boot_id_before" ]');
    expect(acceptance).toContain('boot_has_changed');
    expect(acceptance).toContain('echo reboot-ready');
    expect(acceptance).toContain('current_failure="main-pid-${main_pid_state}-exec-start-${exec_start_state}-active-enter-${active_enter_state}"');
    expect(acceptance).toContain('[ "$size_before" -ge "$recorded_size" ]');
    expect(acceptance).toContain('[ "$size_after" = "$size_before" ]');
    expect(acceptance).not.toContain('write_progress "reboot-${role}-cgroup-removed"');
    for (const rebootStage of ["no-active-units", "no-replacement-pids", "no-output"]) {
      expect(acceptance).toContain(`write_progress reboot-${rebootStage}`);
    }
    expect(probe).toContain("/ws/terminal");
    expect(probe).toContain('message?.type === "attached"');
    expect(probe).toContain('message?.type === "error"');
    expect(probe).toContain("production_probe_roles_server_missing");
    expect(probe).toContain("production_probe_roles_watcher_missing");
    expect(probe).toContain("zellijWatcherPid");
    expect(probe).toContain('`server-${safeCode}`');
    expect(probe).toContain("production_probe_runtime_unavailable");
    expect(probe).toContain("recordAttachStatus");
    expect(probe).toContain("writeFileSync(attachStatusPath");
    expect(acceptance).toContain("read_probe_diagnostic");
    expect(acceptance).toContain("read_controller_diagnostic");
    expect(acceptance).toContain('readonly conflict_id="rt_$(printf');
    expect(acceptance).toContain("cleanup_controller_runtime");
    expect(acceptance).toContain("cleanup_stale_acceptance_runtimes");
    expect(acceptance).toContain("list_stale_acceptance_runtimes");
    expect(acceptance).toContain('os.open(entry.path, os.O_RDONLY | os.O_NOFOLLOW)');
    expect(acceptance).toContain('re.fullmatch(r"u-[sradlpc]-[1-9][0-9]{0,19}-[1-9][0-9]{0,5}", display_name)');
    expect(prepareWorker).toContain("cleanup_stale_acceptance_runtimes");
    expect(acceptance).toContain('owner_systemctl stop "matrix-zellij@${runtime_id}.service"');
    expect(acceptance).toContain('rm -f -- "${descriptor_root}/${runtime_id}.json"');
    expect(acceptance).not.toContain("readonly conflict_id=rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(acceptance).toContain('local layout_path="${home}/system/zellij/layouts/matrix.kdl"');
    expect(acceptance).toContain('controller_diagnostic="${state_root}/hostile-controller.diagnostic"');
    expect(acceptance).toContain('progress("hostile-controller-invalid-runtime-id")');
    expect(acceptance).toContain('progress(`hostile-controller-create-${safeCreateFailure}`)');
    expect(acceptance).toContain('progress("hostile-controller-inactive-stop")');
    expect(acceptance).toContain('progress("hostile-controller-inactive-start")');
    expect(acceptance).toContain('progress("hostile-controller-inactive-identity")');
    expect(acceptance).toContain('progress("hostile-controller-inactive-restop")');
    expect(acceptance).toContain("diagnose_controller_failure");
    expect(acceptance).toContain('post-rollback-runtime) target_name="$post_rollback_name"');
    expect(acceptance).toContain('new-generation) target_name="$current_generation_name"');
    expect(acceptance).toContain('resource-limit-breach) target_name="$limit_name"');
    expect(acceptance).toContain("journalctl --user -u \"$unit\" --no-pager -n 20 -o cat 2>/dev/null || true");
    expect(acceptance).toContain('current_failure="${controller_status}-descriptor-${descriptor_state}-unit-${unit_result}-exit-${exec_status}-keeper-${keeper_code}"');
    expect(acceptance).toContain('current_failure="${controller_status:-hostile-controller-runtime-unavailable}"');
    expect(acceptance).toContain('attach_diagnostic="${state_root}/attach-${runtime_id}.diagnostic"');
    expect(acceptance).toContain('2>"$attach_diagnostic"');
    expect(acceptance).toContain('attachment-ready-${attach_status}');
    expect(acceptance).toContain('kill -0 "$client_pid"');
    expect(acceptance).toContain("read_probe_status");
    expect(acceptance).toContain('current_failure="snapshot-${probe_status}"');
    expect(acceptance).toContain('snapshot_status="${target}.status"');
    expect(acceptance).toContain("probe_status=timeout");
    expect(acceptance).toContain("MemoryCurrent");
    expect(acceptance).toContain("cgroup.controllers");
    expect(acceptance).toContain("list-sessions");
    expect(probe).toContain("matrix-zellij@");
    expect(probe).toContain("ControlGroup");
    expect(probe).toContain("MemoryMax");
    expect(probe).toContain("TasksMax");
    expect(acceptance).toContain("write_progress");
    expect(acceptance).toContain("set -Eeuo pipefail");
    expect(acceptance).toContain('write_state "failed:${current_progress}:${current_failure}"');
    expect(acceptance).toContain("api-http-${code}-${safe_code}");
    expect(acceptance).toContain("diagnose_api_transport");
    expect(acceptance).toContain('current_failure="api-transport-${curl_state}-gateway-pid-${pid_state}-gateway-${gateway_state}-health-${health_state}-result-${gateway_result}-exit-${gateway_exec_status}-restarts-${gateway_restarts}"');
    expect(acceptance).toContain("write_progress hostile-state-create");
    expect(acceptance).toContain("write_progress hostile-state-pre-api");
    expect(acceptance).toContain("write_progress hostile-state-api");
    expect(prepareOperation).toContain("remove_hostile_state || true");
    expect(acceptance).toContain('systemctl show matrix-gateway.service -p Result --value');
    expect(acceptance).toContain('systemctl show matrix-gateway.service -p ExecMainStatus --value');
    expect(acceptance).toContain('systemctl show matrix-gateway.service -p NRestarts --value');
    expect(acceptance).toContain('7) curl_state=connect');
    expect(acceptance).toContain('56) curl_state=receive');
    expect(acceptance).toContain("auth-env-missing");
    expect(acceptance).toContain("auth-token-invalid");
    expect(acceptance).toContain("attachment-ready-timeout");
    expect(acceptance).toContain("attachment-process-missing");
    expect(acceptance).toContain("attachment-cgroup-mismatch");
    expect(acceptance).toContain("attachment-client-exit");
    expect(acceptance).toContain("attachment-runtime-continuity");
    expect(acceptance).toContain("request-body-invalid");
    expect(acceptance).toContain("preflight-zellij-");
    expect(acceptance).toContain("preflight-user-bus-");
    expect(acceptance).toContain("os.O_NOFOLLOW");
    expect(acceptance).toContain("prepare-exact-head-runtime");
    expect(acceptance).toContain("matrix-sync-agent.service");
    expect(acceptance).toContain(
      '"$(path_state /opt/matrix/staging/update-phase)" = missing',
    );
    expect(acceptance).toContain(
      '"$(cat /opt/matrix/app/BUNDLE_VERSION)" = "$preview_version"',
    );
    expect(acceptance).toContain(
      '"$(path_state /opt/matrix/app/.update-error.json)" = missing',
    );
    expect(acceptance).toContain("installed_terminal_runtime_is_ready");
    expect(prepareWorker).toContain("exact_head_runtime_is_ready");
    expect(prepareWorker).toContain("readiness_deadline=$((SECONDS + 1800))");
    expect(prepareWorker).toContain("readiness_state=waiting");
    expect(prepareWorker).toContain('diagnose_update_failure "$preview_version"');
    expect(prepareWorker).toContain("readiness_state=ready");
    expect(prepareWorker).not.toContain(
      'matrix-update --no-tail "$preview_version"',
    );
    expect(prepareWorker).not.toContain("reapply_sync_pid");
    expect(acceptance).not.toMatch(/\bjq\b/);
    expect(acceptance).toContain("matrix-terminal-user-keeper:");
    expect(acceptance).toContain("ExecMainStatus");
    expect(acceptance).toContain("write_progress runtime-shell-create");
    expect(acceptance).toContain("write_progress runtime-agent-create");
    expect(acceptance).toContain("write_progress runtime-shell-snapshot");
    expect(acceptance).toContain("write_progress runtime-agent-snapshot");
    expect(acceptance).toContain('/usr/bin/timeout --signal=KILL 15');
    expect(probe).toContain('production_probe_roles_main_missing');
    expect(probe).toContain('production_probe_roles_zellij_0');
    expect(probe).toContain('production_probe_roles_zellij_1');
    expect(probe).toContain('production_probe_roles_workload_missing');
    expect(probe).not.toContain('production_probe_roles_invalid');
    expect(acceptance).toContain("failed:phase-worker-exited:");
    expect(acceptance).toContain("deadline=$((SECONDS + 5400))");
    expect(acceptance).not.toContain("for _ in $(seq 1 5400)");
    expect(acceptance).toContain("read_update_error_code");
    expect(acceptance).toContain("read_update_phase");
    expect(acceptance).toContain("diagnose_update_failure");
    expect(acceptance).toContain("classify_updater_phase");
    expect(acceptance).toContain("installed_bounded_updater_is_ready");
    expect(acceptance).toContain("/usr/bin/timeout --signal=KILL 1800 curl");
    expect(acceptance).toContain('current_failure="update-${version_state}-target-${target_state}-trigger-${trigger_state}-manifest-${manifest_state}-error-${error_code}-phase-${update_phase}-protocol-${updater_protocol}-updater-${updater_state}-bundle-${bundle_state}-sync-${sync_state}-result-${sync_result}-exit-${sync_exit}-restarts-${sync_restarts}-gateway-${gateway_state}-health-${health_state}"');
    expect(acceptance).toContain('if [ "$error_code" != none ]; then');
    expect(acceptance).toContain('explicit_update_idle_ticks=0');
    expect(acceptance).toContain('if [ "$explicit_update_idle_ticks" -ge 60 ]; then');
    expect(acceptance).toContain('local expected="$1" update_mode="${2:-explicit}"');
    expect(acceptance).toContain('wait_update "$version_a" explicit');
    expect(acceptance).toContain('wait_update "$version_b" explicit');
    expect(acceptance).toContain('wait_update "$version_a" rollback');
    expect(acceptance).toContain('read_update_target');
    expect(acceptance).toContain('read_update_manifest_version');
    expect(acceptance).toContain('update_target_mismatch');
    expect(acceptance).toContain('classify_installed_updater_protocol');
    expect(acceptance).toContain('systemctl show matrix-sync-agent.service -p NRestarts --value');
    expect(acceptance).toContain('case "$error_code" in');
    expect(acceptance).toContain('download_failed|download_metadata_changed|update_target_mismatch|insufficient_disk_space|checksum_mismatch|bundle_extract_failed|bundle_layout_invalid|release_metadata_invalid|terminal_runtime_helper_install_failed|terminal_runtime_install_failed|post_install_host_bin_failed|post_install_release_metadata_failed|post_install_service_start_failed|post_install_health_failed|post_install_rollback_failed|apply_failed|apply_interrupted|unknown)');
    expect(acceptance).not.toContain("journalctl -u matrix-sync-agent");
    expect(workflow).toContain("Acceptance stalled at ${state:-unavailable}");
    expect(workflow).toContain("Acceptance failed at ${state}");
    expect(workflow).toContain("progress_deadline=$((SECONDS + progress_timeout))");
    expect(workflow).toContain("progress_timeout=5700");
    expect(workflow).toContain("Acceptance phase stalled at ${state}");
    expect(workflow).toContain('echo "version=$version" >>"$GITHUB_OUTPUT"');
    expect(workflow).toContain("PREVIEW_VERSION: ${{ steps.preview.outputs.version }}");
    expect(workflow).toContain("$op,$sha,$nonce,$version");
    const recoveryStep = workflow.slice(
      workflow.indexOf("- name: Recover the exact-head disposable preview updater"),
      workflow.indexOf("- name: Install bounded acceptance assets through the authenticated runtime"),
    );
    expect(recoveryStep).toContain("classify_recovery_phase");
    expect(recoveryStep).toContain("probe_runtime_readiness");
    expect(recoveryStep).toContain("pending:update-trigger");
    expect(recoveryStep).toContain("pending:update-phase");
    expect(recoveryStep).toContain("pending:update-error");
    expect(recoveryStep).toContain("pending:generation-assets");
    expect(recoveryStep).toContain("pending:generation-digest");
    expect(recoveryStep).toContain("pending:zellij-exec");
    expect(recoveryStep).toContain("invalid:generation-digest");
    expect(recoveryStep).toContain('host_readiness="$(probe_runtime_readiness)"');
    expect(recoveryStep).toContain(
      'if [ "$current_version" != "$target_version" ] || [ "$host_readiness" != ready ]; then',
    );
    expect(recoveryStep).toContain('case "$host_readiness" in\n' +
      '              invalid:*)');
    expect(recoveryStep).toContain('host_readiness="$(probe_runtime_readiness 2>/dev/null || true)"');
    expect(recoveryStep).toContain(
      'if [ "$version" = "$target_version" ] && [ "$fleet_address" = "$address" ] &&\n' +
        '              [ "$host_readiness" = ready ]; then',
    );
    expect(recoveryStep).toContain("prepare|download|verify|extract|terminal-runtime)");
    expect(recoveryStep).toContain("app-install|host-bin|health|invalid)");
    expect(recoveryStep).toContain('if [ "$recovery_phase" = terminal-runtime ]; then');
    expect(recoveryStep).toContain('"/usr/bin/timeout","--signal=KILL","30","/usr/bin/systemctl","--user","daemon-reload"');
    expect(recoveryStep).toContain(
      'body=\'{"command":["/usr/bin/sudo","/usr/bin/systemctl","stop","--no-block","matrix-sync-agent.service"]}\'',
    );
    expect(recoveryStep.indexOf('deploy_body="$(jq -cn')).toBeGreaterThanOrEqual(0);
    expect(recoveryStep.indexOf('deploy_body="$(jq -cn')).toBeGreaterThan(
      recoveryStep.indexOf(
        'body=\'{"command":["/usr/bin/sudo","/usr/bin/systemctl","start","matrix-sync-agent.service"]}\'',
      ),
    );
    expect(recoveryStep).toContain("deadline=$((SECONDS + 1200))");
    expect(recoveryStep).toContain(
      '"/usr/bin/systemctl","show","matrix-sync-agent.service","--property=ActiveState"',
    );
    expect(recoveryStep).toContain("inactive_samples");
    expect(recoveryStep).toContain("probe_failures");
    expect(recoveryStep).toContain("last_host_readiness");
    expect(recoveryStep).toContain(
      'Exact-head preview was unavailable after a bounded wait: readiness=${last_host_readiness}; ${recovery_diagnostic}.',
    );
    expect(recoveryStep).toContain("if ! curl --fail --silent --show-error");
    expect(recoveryStep).toContain("return 1");
    expect(recoveryStep).toContain('echo "address=$address" >>"$GITHUB_OUTPUT"');
    expect(workflow).not.toContain("deadline=$((SECONDS + 3600))");
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
