import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { link, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  MAX_EVIDENCE_FILE_BYTES,
  packEvidenceDirectory,
  reportGateChecks,
  unpackEvidenceEnvelope,
  validateEvidenceDirectory,
} from '../../scripts/spikes/terminal-runtime/verify-evidence.mjs';
const roots: string[] = [];
const expectAll = (source: string, expected: string[]) => {
  for (const value of expected) expect(source).toContain(value);
};
const readRepo = (path: string) => readFile(join(process.cwd(), path), 'utf8');
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const passing = (names: string) => Object.fromEntries(names.split(/\s+/).map((name) => [name, true]));
const s1Checks = passing(`keeperMainPid runtimeCgroupMembers gatewayOutsideCgroup attachOutsideCgroup
detachPreservesPids gatewayRestartPreservesPids gatewayCrashPreservesPids shellRestartPreservesPids
stopEmptiesCgroup keeperLossDeterministic serverLossDeterministic readinessGated layeredMemoryHigh`);
const s2Checks = passing(`exactOptionSyntax cacheMappedByRuntime layoutRestored viewportRestored
scrollbackBounded lossWindowBounded commandsConfirmationGated forceRunAbsent corruptionFallback
deletionComplete diskAccountingBounded liveSerializationDisableSafe`);
const productionChecks = passing(`runtimeLive continuousOutput codingAgentPreserved twoDevicesOneRuntime detachPreservesRuntime renamePreservesIdentity bundleOnePreservesRuntime bundleTwoPreservesRuntime supervisorPreserved failedUpdatePreservesRuntime explicitRollbackPreservesRuntime daemonReloadPreservesRuntime forceRunAbsent journalPrivacy
rebootStartsNoRuntime rebootShowsInterrupted explicitRecoverRestoresRuntime recoveryDoesNotResumeAgent concurrentRecoverSingleUnit corruptionFallsBackFresh recoverDeleteCannotResurrect deleteWaitsForEmptyCgroup deleteRemovesRecoveryState`);
async function evidence(overrides: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-evidence-'));
  roots.push(root);
  await mkdir(join(root, 's1'));
  const body = `${JSON.stringify({
    role: 'keeper',
    pid: 4201,
    cgroup: '/matrix-terminal.slice/matrix-terminal-spike.slice/runtime.scope',
  })}\n`;
  await writeFile(join(root, 's1', 'processes.json'), body, 'utf8');
  const file = {
    path: 's1/processes.json',
    bytes: Buffer.byteLength(body),
    sha256: createHash('sha256').update(body).digest('hex'),
  };
  const summary = {
    schemaVersion: 1,
    prHeadSha: 'a'.repeat(40),
    zellijVersion: 'zellij 0.44.3',
    zellijBuild: {
      buildId: 'v0.44.3-matrix.1',
      sourceVersion: '0.44.3',
      sourceSha256: '33ae61fc802b59462fed49b424893596d3aa819646bdce53d5602f714c1264fe',
      patchSha256: 'bee3d6c227402258faee58c9f57ed282a368ab39fd38e619b39d4bd5ec8f2571',
      rustVersion: '1.92.0',
      target: 'x86_64-unknown-linux-musl',
      sourceDateEpoch: 1735689600,
      pathRemap: '/usr/src/matrix-zellij',
      builder: 'github-actions-ubuntu-24.04',
      workRoot: '/tmp/matrix-zellij-build-v0.44.3-matrix.1',
      binarySha256: '534455dc62c8e3753918d012547d10159ee07929f570a5873a754957502a49c4',
    },
    ubuntuVersion: '24.04',
    systemdVersion: '255',
    kernelVersion: '6.8.0-probe',
    s1: { status: 'pass', checks: s1Checks },
    s2: { status: 'pass', checks: s2Checks },
    privacyScan: { status: 'pass', findings: 0 },
    files: [file],
    totalBytes: file.bytes,
    ...overrides,
  };
  await writeFile(join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return root;
}
describe('terminal runtime spike evidence', () => {
  it('runs the evidence CLI when invoked through the immutable current-generation symlink', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'matrix-terminal-verifier-symlink-'));
    roots.push(fixture); const generation = join(fixture, 'generation'); const current = join(fixture, 'current');
    await mkdir(generation);
    await Promise.all([
      writeFile(join(generation, 'verify-evidence.mjs'), await readRepo('scripts/spikes/terminal-runtime/verify-evidence.mjs')),
      writeFile(join(generation, 'v0.44.3-matrix.1.build.json'), await readRepo('scripts/terminal-runtime/zellij/v0.44.3-matrix.1.build.json')),
    ]);
    await symlink(generation, current, 'dir'); const root = await evidence();
    const result = spawnSync(process.execPath, [join(current, 'verify-evidence.mjs'), root, '--pack', 'a'.repeat(40)], { encoding: 'utf8' });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, prHeadSha: 'a'.repeat(40) });
  });

  it('builds and verifies the pinned Matrix Zellij resurrection patch', async () => {
    const [
      builder,
      zellijPatch,
      candidateRecordRaw,
      previewWorkflow,
      buildScript,
      syncAgent,
      remoteRunner,
      verifier,
      research,
    ] = await Promise.all([
      readFile(join(process.cwd(), 'scripts/terminal-runtime/zellij/build.sh'), 'utf8'),
      readFile(
        join(process.cwd(), 'scripts/terminal-runtime/zellij/v0.44.3-matrix.1.patch'),
        'utf8',
      ),
      readFile(
        join(
          process.cwd(),
          'scripts/terminal-runtime/zellij/v0.44.3-matrix.1.build.json',
        ),
        'utf8',
      ),
      readFile(join(process.cwd(), '.github/workflows/preview-vps.yml'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/build-host-bundle.sh'), 'utf8'),
      readFile(join(process.cwd(), 'distro/customer-vps/host-bin/matrix-sync-agent'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/run-remote.sh'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/verify-evidence.mjs'), 'utf8'),
      readFile(join(process.cwd(), 'specs/109-persist-terminal-sessions/research.md'), 'utf8'),
    ]);
    const candidateRecord = JSON.parse(candidateRecordRaw) as Record<string, unknown>;
    expect(candidateRecord).toEqual({
      buildId: 'v0.44.3-matrix.1',
      sourceVersion: '0.44.3',
      sourceSha256: '33ae61fc802b59462fed49b424893596d3aa819646bdce53d5602f714c1264fe',
      patchSha256: 'bee3d6c227402258faee58c9f57ed282a368ab39fd38e619b39d4bd5ec8f2571',
      rustVersion: '1.92.0',
      target: 'x86_64-unknown-linux-musl',
      sourceDateEpoch: 1735689600,
      pathRemap: '/usr/src/matrix-zellij',
      builder: 'github-actions-ubuntu-24.04',
      workRoot: '/tmp/matrix-zellij-build-v0.44.3-matrix.1',
      binarySha256: '534455dc62c8e3753918d012547d10159ee07929f570a5873a754957502a49c4',
    });
    expectAll(builder, ['v0.44.3-matrix.1.build.json', 'cp -- "$candidate_record" "$output_dir/build.json"',
      'ZELLIJ_SOURCE_VERSION="$(jq -er .sourceVersion "$candidate_record")"', 'cargo test -p zellij-server',
      'serialized_pane_restores_bounded_viewport_offset', 'ZELLIJ_TARGET="$(jq -er .target "$candidate_record")"',
      'zellij_binary_digest_mismatch', '--target "$ZELLIJ_TARGET"', 'export CARGO_HOME="$work_dir/cargo-home"',
      'work_dir="$ZELLIJ_WORK_ROOT"', 'mkdir -m 0700 -- "$work_dir"', 'export CARGO_INCREMENTAL=0',
      'export SOURCE_DATE_EPOCH="$ZELLIJ_SOURCE_DATE_EPOCH"', '--remap-path-prefix=$work_dir=$ZELLIJ_PATH_REMAP',
      'command_panes_serialize_initial_contents_for_gated_resurrection']);
    expectAll(remoteRunner, ['candidate_build_record="$source_dir/v0.44.3-matrix.1.build.json"',
      'command_bounded 5 /usr/bin/sed \\',
      "-nE 's/^[[:space:]]*\"binarySha256\"",
      'IFS= read -r expected_zellij_binary_sha256 <&9',
      'read -r zellij_binary_sha256 digest_path digest_extra <"$actual_digest_file"',
      'rm -rf -- "$evidence_root"',
      'support_root="$source_dir"',
      'spike_attempt_state_exists']);
    expect(remoteRunner).not.toContain('python3');
    expect(remoteRunner).not.toContain('expected_zellij_binary_sha256="$(');
    expect(remoteRunner).not.toContain('zellij_binary_sha256="$(');
    expect(remoteRunner).not.toContain('/opt/matrix/app');
    expect(remoteRunner).not.toMatch(/\bjq\b/);
    expectAll(verifier, ["CANDIDATE_BUILD_RECORD = 'v0.44.3-matrix.1.build.json'",
      '../../terminal-runtime/zellij/${CANDIDATE_BUILD_RECORD}']);
    const packagedVerifier = await mkdtemp(join(tmpdir(), 'matrix-terminal-packaged-verifier-')); roots.push(packagedVerifier);
    await Promise.all([writeFile(join(packagedVerifier, 'verify-evidence.mjs'), verifier), writeFile(join(packagedVerifier, 'v0.44.3-matrix.1.build.json'), candidateRecordRaw)]);
    await expect(import(/* @vite-ignore */ pathToFileURL(join(packagedVerifier, 'verify-evidence.mjs')).href)).resolves.toBeDefined();
    expectAll(zellijPatch, ['grid_before_banner', 'scrollback_lines_to_serialize.saturating_sub(viewport_lines_to_serialize)',
      '.take(lines_below_to_serialize)', 'matrix-zellij-viewport-offset-v1=',
      'held_resurrected_pane_preserves_viewport_and_history_across_reflow',
      'serialized_pane_content_is_bounded_including_the_viewport', 'serialized_pane_restores_bounded_viewport_offset',
      'restore_serialized_contents', 'command_panes_serialize_initial_contents_for_gated_resurrection',
      '+        if edit.is_none() {']);
    expectAll(previewWorkflow, ['Build verified production Zellij', 'runs-on: ubuntu-24.04',
      'HOST_BUNDLE_ZELLIJ_BUILD_DIR:']);
    expect(buildScript).toContain('HOST_BUNDLE_ZELLIJ_BUILD_DIR');
    expectAll(syncAgent, ['zellij_candidate_digest_mismatch', 'mv -f "$zellij_next" "$BIN_DIR/zellij"',
      'zellij_installed_digest_mismatch', "! -name 'zellij'", "! -name 'zellij.build.json'",
      "! -name 'matrix-terminal-*'", 'backup_zellij_for_rollback', 'restore_zellij_after_rollback',
      'readonly ZELLIJ_ROLLBACK_DIR="$ROLLBACK_STATE_DIR/zellij.rollback"',
      'local rollback_next="${ZELLIJ_ROLLBACK_DIR}.next"', 'mv -- "$rollback_next" "$ZELLIJ_ROLLBACK_DIR"']);
    const rollbackBackup = syncAgent.slice(
      syncAgent.indexOf('backup_zellij_for_rollback()'),
      syncAgent.indexOf('restore_zellij_after_rollback()'),
    );
    expect(rollbackBackup.indexOf('"$rollback_next/zellij"')).toBeLessThan(
      rollbackBackup.indexOf('clear_zellij_rollback'),
    );
    expect(rollbackBackup.indexOf('clear_zellij_rollback')).toBeLessThan(
      rollbackBackup.indexOf('mv -- "$rollback_next" "$ZELLIJ_ROLLBACK_DIR"'),
    );
    expect(syncAgent).toContain(
      'if [ -f "$extract_dir/bin/zellij" ]; then\n    backup_zellij_for_rollback',
    );
    const applyUpdate = syncAgent.slice(
      syncAgent.indexOf('apply_update()'),
      syncAgent.indexOf('# ── Rollback'),
    );
    const serviceStop = applyUpdate.indexOf(
      'systemctl stop matrix-symphony matrix-gateway matrix-shell',
    );
    expect(applyUpdate.indexOf('rm -rf "$APP_DIR.rollback"')).toBeLessThan(serviceStop);
    expect(applyUpdate.indexOf('chown -R matrix:matrix "$extract_dir/app"')).toBeLessThan(
      serviceStop,
    );
    expect(applyUpdate.indexOf('backup_terminal_runtime_for_failed_update')).toBeLessThan(
      serviceStop,
    );
    expect(applyUpdate.indexOf('install_terminal_runtime_generation')).toBeLessThan(
      serviceStop,
    );
    expect(applyUpdate.lastIndexOf('backup_zellij_for_rollback')).toBeLessThan(serviceStop);
    for (const staged of [
      'install_update_runtime_bins',
      'matrix-terminal-runtime-op migrate-legacy',
      'systemctl daemon-reload',
    ]) {
      expect(applyUpdate.lastIndexOf(staged)).toBeLessThan(serviceStop);
    }
    expect(applyUpdate.slice(0, serviceStop)).not.toContain('do_rollback');
    expect(applyUpdate.indexOf('mv "$extract_dir/app" "$APP_DIR"')).toBeGreaterThan(
      serviceStop,
    );
    expect(applyUpdate).not.toContain('chown -R matrix:matrix "$APP_DIR"');
    const legacyZellijInstall = syncAgent.indexOf(
      'if [ -f "$extract_dir/bin/zellij" ]; then',
      syncAgent.indexOf('if [ "$zellij_candidate" = true ]; then'),
    );
    expect(legacyZellijInstall).toBeGreaterThan(-1);
    expect(
      syncAgent.indexOf(
        'install -o root -g root -m 0755',
        legacyZellijInstall,
      ),
    ).toBeLessThan(
      syncAgent.indexOf(
        'rm -f -- "$ZELLIJ_BUILD_METADATA"',
        legacyZellijInstall,
      ),
    );
    expect(syncAgent.indexOf('backup_zellij_for_rollback')).toBeLessThan(
      syncAgent.indexOf('mv -f "$zellij_next" "$BIN_DIR/zellij"'),
    );
    const rollbackBody = syncAgent.slice(syncAgent.indexOf('do_rollback()'));
    expect(rollbackBody).not.toContain('chown -R matrix:matrix "$APP_DIR"');
    expect(rollbackBody.indexOf('restore_zellij_after_rollback')).toBeLessThan(
      rollbackBody.indexOf('systemctl start matrix-gateway matrix-shell'),
    );
    expect(verifier).toContain('const EXPECTED_ZELLIJ_BUILD = Object.freeze(');
    expect(research).toContain('preserve the nine stack layers in `plan.md`');
  });
  it('binds privileged execution to an explicitly approved immutable PR head', async () => {
    const workflow = await readFile(
      join(process.cwd(), '.github/workflows/terminal-runtime-spikes.yml'),
      'utf8',
    );
    expect(workflow).toContain('pull_request:\n    types: [labeled]');
    expect(workflow).toContain("github.event.label.name == 'preview-vps'");
    expect(workflow).not.toContain('types: [labeled, synchronize');
    expect(workflow).toContain('head_sha:\n        description: Exact 40-character PR head SHA to approve');
    expect(workflow).toContain('APPROVED_HEAD_SHA: ${{ github.event.pull_request.head.sha || inputs.head_sha }}');
    expect(workflow).toContain('if [ "$head_sha" != "$APPROVED_HEAD_SHA" ]');
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).toContain('.labels | any(.name == "preview-vps")');
    expect(workflow).toContain('PR_NUMBER: ${{ github.event.pull_request.number || inputs.pr }}');
    expect(workflow).toContain("runtime_version=\"$(jq -r '.runtimeVersion // \"\"' <<<\"$machine\")\"");
    expect(workflow).not.toContain("jq -r '.imageVersion // \"\"'");
    expect(workflow).toContain('--resolve "app.matrix-os.com:443:${PUBLIC_IPV4}"');
    expect(workflow).toContain("'https://app.matrix-os.com/api/terminal/run'");
    expect(workflow.match(/--insecure/g)).toHaveLength(3);
    expect(workflow).toContain('PLATFORM_SECRET never leaves the runner');
    expect(workflow.match(/gateway_http_status=\$http_code/g)).toHaveLength(2);
    expect(workflow).toContain('echo "evidence_diagnostic=${diagnostic}" >&2');
    expect(workflow).toContain('base_wait_started=0');
    expect(workflow).toContain('base_wait_started=$SECONDS');
    expect(workflow).toContain('$((SECONDS - base_wait_started)) -ge 90');
    expect(workflow).toContain('last_pack_success=$SECONDS');
    expect(workflow).toContain('$((SECONDS - last_pack_success)) -ge 120');
    expect(workflow).toContain('evidence_gateway_unavailable_${http_code}');
    expect(workflow).toContain('last_semantic_pack_success=$SECONDS');
    expect(workflow).toContain('semantic_response_timeout=300');
    expect(workflow).toContain(
      '$((SECONDS - last_semantic_pack_success)) -ge "$semantic_response_timeout"',
    );
    expect(workflow).toContain(
      'evidence_gateway_response_invalid_${http_code}_${response_shape}',
    );
    expectAll(workflow, [
      'if type != "object" then "non_object"',
      'elif has("error") then "error_object"',
      'elif ((.exitCode | type) == "number" or .exitCode == null)',
      'then "command_result_exit_" +',
      '(if .exitCode == null then "null" elif .exitCode == 0 then "zero" else "nonzero" end)',
      '(if .signal == null then "none" elif .signal == "SIGTERM" then "sigterm"',
      '(if .stdout == "" then "empty" else "set" end)',
      '(if .stderr == "" then "empty" else "set" end)',
      'else "unknown_object" end',
    ]);
    expect(workflow).not.toContain('VPS_SSH_KEY');
    expect(workflow).toContain('workflow_dispatch:');
  });
  it('isolates every disposable-VPS proof attempt from stale runtime state', async () => {
    const [workflow, helper, launcher, packer, runner, template, keeper] = await Promise.all([
      readRepo('.github/workflows/terminal-runtime-spikes.yml'),
      readRepo('distro/customer-vps/host-bin/matrix-terminal-spike-control'),
      readRepo('scripts/spikes/terminal-runtime/launch-remote.sh'),
      readRepo('scripts/spikes/terminal-runtime/pack-evidence.sh'),
      readRepo('scripts/spikes/terminal-runtime/run-remote.sh'),
      readRepo('scripts/spikes/terminal-runtime/matrix-terminal-spike-template.service'),
      readRepo('scripts/spikes/terminal-runtime/keeper.mjs'),
    ]);
    expect(workflow).toContain('RUN_NONCE: ${{ github.run_id }}-${{ github.run_attempt }}');
    expect(workflow.match(/--arg nonce "\$RUN_NONCE"/g)).toHaveLength(2);
    expect(workflow.match(/\$sha,\n\s+\$nonce/g)).toHaveLength(2);
    expectAll(helper, [
      'launch | pack)',
      '[[ "$3" =~ ^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$ ]]',
      'exec /usr/bin/bash "$target" "$pr_head_sha" "$3"',
    ]);
    for (const script of [launcher, packer, runner]) {
      expect(script).toContain('run_nonce="${2:-}"');
      expect(script).toContain('run_namespace="${pr_head_sha:0:5}${run_id_padded}${run_attempt_padded}"');
    }
    expect(launcher).toContain('matrix-terminal-runtime-spike-${run_namespace}.service');
    expect(packer).toContain('matrix-terminal-spike-evidence-${pr_head_sha}-${run_nonce}');
    expect(runner).toContain('support_root="$source_dir"');
    expect(runner).not.toContain('quarantine_setup_path');
    expect(runner).not.toContain('runtime_cleanup_paths=');
    expect(runner).not.toContain('support_root.next');
    expect(template).toContain('/opt/matrix/libexec/terminal-runtime/current/spikes/keeper.mjs');
    expect(keeper).toContain('/opt/matrix/libexec/terminal-runtime/current/spikes/layout.kdl');
  });
  it('starts a plain initial shell and launches the fixed workload pane explicitly', async () => {
    const layout = await readRepo('scripts/spikes/terminal-runtime/layout.kdl');
    const keeper = await readRepo('scripts/spikes/terminal-runtime/keeper.mjs');
    expect(layout).toContain('    pane\n');
    expect(layout).not.toContain('command=');
    expect(layout).not.toContain('/opt/matrix/libexec/terminal-runtime/current/');
    expect(layout).not.toContain('/opt/matrix/libexec/terminal-runtime-spike/');
    expect(keeper).toContain(
      "['--session', sessionName, 'action', 'new-pane', '--name', WORKLOAD_PANE_NAME, '--', NODE, WORKLOAD_PANE]",
    );
    expect(keeper).toContain("const WORKLOAD_PANE_NAME = 'matrix-runtime-workload-probe'");
  });
  it('launches spike panes through an immutable generation helper', async () => {
    const [wrapper, buildScript, updater] = await Promise.all([
      readRepo('scripts/spikes/terminal-runtime/workload-pane.mjs'),
      readRepo('scripts/build-host-bundle.sh'),
      readRepo('distro/customer-vps/host-bin/matrix-sync-agent'),
    ]);
    expectAll(wrapper, [
      '#!/usr/bin/env node',
      'if (process.argv.length !== 2)',
      'setInterval(() => undefined, 60_000)',
    ]);
    expect(wrapper).not.toContain('exec -a');
    expect(wrapper).not.toContain('/usr/bin/sleep');
    expect(wrapper).not.toContain('bash --noprofile');
    expect(wrapper).not.toContain('/opt/matrix/');
    expect(wrapper).not.toContain('--force-run-commands');
    expect(buildScript).toContain(
      'cp -a --no-preserve=links "$ROOT_DIR/scripts/spikes/terminal-runtime/." "$terminal_generation_build/spikes/"',
    );
    expect(buildScript).toContain(
      'rm -f -- "$STAGE_DIR/bin/matrix-terminal-spike-pane"',
    );
    expect(updater).toContain('rm -f -- "$BIN_DIR/matrix-terminal-spike-pane"');
    expect(updater).not.toContain('name="matrix-terminal-spike-pane"');
  });
  it('preflights the exact installed workload helper before asking Zellij to launch it', async () => {
    const [keeper, packer] = await Promise.all([readRepo('scripts/spikes/terminal-runtime/keeper.mjs'), readRepo('scripts/spikes/terminal-runtime/pack-evidence.sh')]);
    expectAll(keeper, [
      'async function verifyWorkloadHelper()', "spawnProcess(NODE, [WORKLOAD_PANE], {", "throw new Error('workload_helper')", 'await verifyWorkloadHelper();',
      "const WORKLOAD_HELPER_STATES = new Set([", 'workloadHelperState', 'workloadHelperExitStatus', "workloadHelperState = 'spawn_error'",
      "workloadHelperState = 'early_exit'", "workloadHelperState = 'running'", "workloadHelperState = 'cleanup_error'", "workloadHelperState = 'cleanup_timeout'",
    ]);
    expectAll(packer, [
      'keeper_helper', 'keeper_helper_exit', 'failure_helper', 'failure_helper_exit', 'v.workloadHelperState', 'v.workloadHelperExitStatus',
      'q${keeper_helper}', 'j${keeper_helper_exit}', 'q${failure_helper}', 'j${failure_helper_exit}', 'failure_progress', 'failure_runner_status',
      'failure_base_state', 'failure_base_substate', 'failure_base_status', 'd${failure_progress}', 'u${failure_runner_status}',
      'b${failure_base_state}_${failure_base_substate}_${failure_base_status}',
    ]);
    expect(keeper.indexOf('await verifyWorkloadHelper();')).toBeLessThan(keeper.indexOf('await launchCreateWorkloadPane(sessionName, env);'));
  });
  it('carries the compatible stable updater through a dormant preview bootstrap', async () => {
    const workflow = await readRepo('.github/workflows/preview-vps.yml');
    expect(workflow).toContain(
      'cp distro/customer-vps/host-bin/matrix-sync-agent "$RUNNER_TEMP/"',
    );
    expect(workflow).toContain(
      'install -m 0755 "$RUNNER_TEMP/matrix-sync-agent" distro/customer-vps/host-bin/matrix-sync-agent',
    );
    expect(workflow).toContain(
      'install -m 0755 "$RUNNER_TEMP/matrix-sync-bundled-home-assets" distro/customer-vps/host-bin/matrix-sync-bundled-home-assets',
    );
    expect(workflow).toContain(
      'git restore --source=HEAD -- scripts/build-host-bundle.sh scripts/spikes/terminal-runtime distro/customer-vps/host-bin/matrix-gateway distro/customer-vps/host-bin/matrix-restore.sh distro/customer-vps/host-bin/matrix-sync-agent distro/customer-vps/host-bin/matrix-sync-bundled-home-assets',
    );
    expect(workflow.indexOf('install -m 0755 "$RUNNER_TEMP/matrix-sync-agent"')).toBeLessThan(
      workflow.indexOf('MATRIX_TERMINAL_RUNTIME_DORMANT=1 ./scripts/build-host-bundle.sh'),
    );
  });
  it('keeps panes runtime-agnostic and gates readiness in the keeper', async () => {
    const [keeper, paneProbe] = await Promise.all([
      readRepo('scripts/spikes/terminal-runtime/keeper.mjs'),
      readRepo('scripts/spikes/terminal-runtime/pane-probe.sh'),
    ]);
    expect(keeper).toContain('const paneReleasePath = `${runtimeRoot}/pane-release/${sessionName}`');
    expect(keeper).toContain('const paneReleased = await regularFileExists(paneReleasePath);');
    expect(keeper).toContain(
      "const startupAuthorized = descriptor.intent === 'recover' || paneReleased;",
    );
    expect(keeper).toContain(
      "if (paneReleased && responsive && descriptor.intent === 'create' && !workloadPaneLaunched)",
    );
    expect(keeper).not.toContain(
      "paneReleased && gateRecorded && descriptor.intent === 'create'",
    );
    expect(keeper).toContain("const WORKLOAD_PANE = join(dirname(keeperExecutable), 'workload-pane.mjs')");
    expect(keeper).toContain("process.comm === 'MainThread'");
    expect(keeper).toContain('process.cmdline[0] === NODE');
    expect(keeper).toContain('process.cmdline[1] === WORKLOAD_PANE');
    expect(keeper).toContain("['--session', sessionName, 'action', 'new-pane', '--name', WORKLOAD_PANE_NAME, '--', NODE, WORKLOAD_PANE]");
    expect(keeper).toContain("throw new Error('workload_launch'");
    expect(keeper).not.toContain("throw new Error('workload_target')");
    expect(keeper).not.toContain('const target = stdout.trim()');
    expect(keeper).toContain('workloadPaneLaunched = true');
    expect(keeper.indexOf('await execFileAsync(')).toBeLessThan(
      keeper.indexOf('workloadPaneLaunched = true'),
    );
    expect(keeper.indexOf('workloadPaneLaunched = true')).toBeLessThan(
      keeper.indexOf('await cgroupRoles(cgroup.path, descriptor.intent === \'create\')'),
    );
    expect(keeper).toContain("confirmationState = descriptor.intent === 'create' ? 'not_required' : 'waiting'");
    expect(keeper).toContain("confirmationState = 'gated'");
    expect(keeper).not.toContain('confirmHeldCreatePane');
    expect(keeper).not.toContain("'action', 'send-keys'");
    expect(keeper).not.toContain("'action', 'write', '13'");
    expect(keeper).not.toContain("pty.write('\\r')");
    expect(keeper).toContain("if (startupAuthorized && responsive && detected && (descriptor.intent === 'create' || gateRecorded))");
    expect(keeper.indexOf('const responsive = startupAuthorized')).toBeLessThan(
      keeper.indexOf("descriptor.intent === 'create' && !workloadPaneLaunched"),
    );
    expect(paneProbe).not.toContain('MATRIX_TERMINAL_RUNTIME_ID');
    expect(paneProbe).not.toContain('/proc/self/cgroup');
    expect(paneProbe).not.toContain('pane-release');
    expect(keeper).not.toContain('MATRIX_TERMINAL_RUNTIME_ID');
  });
  it('records a bounded privacy-safe workload pane state for failed readiness', async () => {
    const [keeper, packer] = await Promise.all([readRepo('scripts/spikes/terminal-runtime/keeper.mjs'), readRepo('scripts/spikes/terminal-runtime/pack-evidence.sh')]);
    expectAll(keeper, [
      "const WORKLOAD_PANE_STATES = new Set([", "['--session', sessionName, 'action', 'list-panes', '--all', '--json']", 'panes.length > 16',
      'pane.terminal_command === `${NODE} ${WORKLOAD_PANE}`', 'pane.pane_command === `${NODE} ${WORKLOAD_PANE}`',
      'workloadPaneState', 'workloadPaneExitStatus', 'pane.exit_status',
    ]);
    expectAll(packer, [
      'keeper_workload', 'keeper_workload_exit', 'failure_workload', 'failure_workload_exit',
      'w${keeper_workload}', 'e${keeper_workload_exit}', 'w${failure_workload}', 'e${failure_workload_exit}',
      '/^(not_launched|missing|running|held_success|held_failure|other|ambiguous)$/.test(v.workloadPaneState)',
      '(v.workloadPaneExitStatus!==null&&(!Number.isInteger(v.workloadPaneExitStatus)||v.workloadPaneExitStatus<0||v.workloadPaneExitStatus>255))',
    ]);
  });
  it('can remove only its immutable disposable preview before a clean proof', async () => {
    const workflow = await readFile(
      join(process.cwd(), '.github/workflows/terminal-runtime-spikes.yml'),
      'utf8',
    );
    expectAll(workflow, ["github.event.label.name == 'terminal-preview-reprovision'", 'any(.name == "terminal-preview-reprovision")',
      'type == "array" and length <= 8',
      '.deletedAt == null and .status != "deleted"',
      '(.runtimeSlot == $handle or .status == "failed")',
      '.deletedAt == null and\n                .status != "deleted"',
      'while IFS= read -r machine_id; do',
      '-X DELETE "${PLATFORM_PUBLIC_URL%/}/vps/${machine_id}"']);
    expect(workflow).not.toContain('type == "array" and length >= 1 and length <= 8');
  });
  it('packages the harness only for explicitly marked preview bundles', async () => {
    const [buildScript, previewWorkflow] = await Promise.all([
      readFile(join(process.cwd(), 'scripts/build-host-bundle.sh'), 'utf8'),
      readFile(join(process.cwd(), '.github/workflows/preview-vps.yml'), 'utf8'),
    ]);
    expect(previewWorkflow).toContain("MATRIX_TERMINAL_RUNTIME_SPIKE: '1'");
    expect(buildScript).toContain('if [ "${MATRIX_TERMINAL_RUNTIME_SPIKE:-0}" = "1" ]; then');
    expect(buildScript).toContain('chmod 0755 "$terminal_generation_build/spikes/"{launch-remote,pack-evidence,pane-probe,run-remote,production-acceptance}.sh');
    expectAll(buildScript, ['matrix-terminal-spike.slice" "$STAGE_DIR/systemd/matrix-terminal-spike.slice"', 'matrix-terminal-spike-template.service" "$STAGE_DIR/systemd/matrix-terminal-spike@.service"']);
  });
  it('binds every spike control operation to the installed exact-head generation', async () => {
    const [buildScript, control] = await Promise.all([
      readRepo('scripts/build-host-bundle.sh'),
      readRepo('distro/customer-vps/host-bin/matrix-terminal-spike-control'),
    ]);
    expect(buildScript).toContain(
      '"$terminal_generation_build/spikes/build-head-sha"',
    );
    expectAll(control, [
      'generation_head_path="/opt/matrix/libexec/terminal-runtime/current/spikes/build-head-sha"',
      'spike_control_generation_mismatch',
      '[ "$generation_head" != "$pr_head_sha" ]',
    ]);
    expect(control.indexOf('[ "$generation_head" != "$pr_head_sha" ]')).toBeLessThan(
      control.indexOf('exec /usr/bin/bash "$target"'),
    );
  });
  it('gives CI change detection observed checkout time plus margin', async () => {
    const workflow = await readRepo('.github/workflows/ci.yml');
    const changesJob = workflow.slice(
      workflow.indexOf('  changes:'),
      workflow.indexOf('\n  # ── Gate 1:'),
    );
    expect(changesJob).toContain('timeout-minutes: 5');
    expect(changesJob).not.toContain('timeout-minutes: 2');
  });
  it('requires an exact-head production acceptance matrix beyond S1 and S2', async () => {
    const [workflow, helper, runner, verifier, probe] = await Promise.all([
      readRepo('.github/workflows/terminal-runtime-production-acceptance.yml'),
      readRepo('distro/customer-vps/host-bin/matrix-terminal-spike-control'), readRepo('scripts/spikes/terminal-runtime/production-acceptance.sh'),
      readRepo('scripts/spikes/terminal-runtime/verify-production-evidence.mjs'),
      readRepo('scripts/spikes/terminal-runtime/production-probe.mjs'),
    ]);
    expectAll(workflow, ["github.event.label.name == 'terminal-production-acceptance'", 'timeout-minutes: 360', 'deadline=$((SECONDS + 11400))',
      'call_helper acceptance-launch', 'call_helper acceptance-reboot', 'call_helper acceptance-resume',
      'call_helper acceptance-pack', 'call_helper acceptance-cancel',
      'production_acceptance_state=${state}', 'Validate the complete production matrix']);
    expect(workflow).toContain("group: terminal-runtime-production-${{ github.event.label.name == 'terminal-production-acceptance' && github.event.pull_request.number || github.run_id }}");
    expect(workflow).not.toContain('group: terminal-runtime-production-${{ github.event.pull_request.number }}\n');
    const cancellationCleanup = workflow.slice(workflow.indexOf('- name: Cancel incomplete production acceptance'));
    expectAll(cancellationCleanup, [
      "if: ${{ (cancelled() || failure()) && steps.recover.outcome != 'success' }}", 'acceptance-cancel', '--max-time 45',
    ]);
    expectAll(runner, [
      'readonly update_wait_seconds=1800', 'for _ in $(seq 1 "$update_wait_seconds")', '--property=RuntimeMaxSec=10800', '--property=RuntimeMaxSec=600',
      '--property=TimeoutStopSec=45', 'systemctl_cancel stop', 'write_phase runtime_created', 'write_phase bundle_one', 'write_phase bundle_two',
      'write_phase forced_failure', 'write_phase reapply_one', 'write_phase rollback_two', 'write_phase final_checks', 'write_phase creating_runtime',
      'write_phase waiting_runtime', 'write_phase seeding_output', 'write_phase starting_agent', 'write_phase waiting_roles',
      'owner_probe() { command_bounded 70 runuser -u matrix --',
      'trap \'status=$?; trap - EXIT; [ "$status" -eq 0 ] || fail_phase "$status"\' EXIT', 'grep -aqF \'MATRIX_ACCEPT_LOOP\' "/proc/${shell_pid}/cmdline"',
    ]);
    expect(runner).not.toContain('for _ in $(seq 1 4500)');
    expect(workflow).not.toMatch(/^\s+env:\n\s+env:/m);
    expectAll(helper, ['acceptance-launch | acceptance-status | acceptance-reboot | acceptance-resume | acceptance-pack | acceptance-cancel', 'exec /usr/bin/bash "$target"']);
    expect(helper).not.toContain('[ ! -x "$target" ]');
    for (const check of `bundleOnePreservesRuntime bundleTwoPreservesRuntime failedUpdatePreservesRuntime explicitRollbackPreservesRuntime rebootStartsNoRuntime
explicitRecoverRestoresRuntime recoveryDoesNotResumeAgent concurrentRecoverSingleUnit recoverDeleteCannotResurrect corruptionFallsBackFresh deleteWaitsForEmptyCgroup`.split(/\s+/)) {
      expect(runner).toContain(check);
      expect(verifier).toContain(check);
    }
    expect(runner).toContain("pgrep -a zellij | grep -F -- '--force-run-commands'");
    expect(runner).not.toMatch(/zellij(?:_cmd)?\s[^|\n]*--force-run-commands/);
    expect(runner).toContain('readonly pi=/opt/matrix/runtime/node/bin/pi');
    expectAll(runner, ['[ -x "$pi" ]', 'owner_probe create-agent "$head_sha" "$run_nonce"',
      'both_roles_match "$runtime_id" "$agent_runtime_id"', 'mark recoveryDoesNotResumeAgent']);
    expect(runner).not.toContain('action new-pane -- "$codex" app-server');
    expect(runner).not.toContain("sh -c 'command -v codex'");
    expect(runner).toContain('owner_probe create "$head_sha" "$run_nonce"');
    expectAll(probe, [
      '`accept-${value.slice(0, 12)}-${extra}`', '`accept-agent-${value.slice(0, 12)}-${extra}`', 'createAgentConfigurationStore',
      "launch: { kind: 'agent', configurationRef: operationId }", "agent: 'pi'",
      "processes.find((entry) => entry.comm === 'bash')?.pid ?? 0", '/\\/pi(?:[./-]|$)/',
    ]);
    expect(probe).not.toContain("prompt:");
    expect(probe).not.toContain("argument.includes('MATRIX_ACCEPT_LOOP')");
    expect(workflow).not.toContain('VPS_SSH_KEY');
  });
  it('publishes a terminal acceptance state before bounded systemd cleanup', async () => {
    const runner = await readRepo('scripts/spikes/terminal-runtime/production-acceptance.sh');
    expectAll(runner, [
      'systemctl_read()', 'systemctl_change()', 'systemctl_cancel()', 'systemctl_read() { command_bounded 8 /usr/bin/systemctl "$@"; }',
      'systemctl_change() { command_bounded 40 /usr/bin/systemctl "$@"; }', 'systemctl_cancel() { command_bounded 20 /usr/bin/systemctl "$@"; }',
      'trap - EXIT ERR TERM INT HUP', 'local exit_status="${1:-$?}"', 'failure_code=command_timeout',
    ]);
    const failPhase = runner.slice(runner.indexOf('fail_phase() {'), runner.indexOf('\nphase1() {'));
    const failureWrite = failPhase.indexOf('write_state "failed_${current_phase}_${failure_code}"');
    expect(failureWrite).toBeGreaterThan(-1); expect(failureWrite).toBeLessThan(failPhase.indexOf('systemctl_change daemon-reload'));
    const cancelCase = runner.slice(runner.indexOf('  cancel)'), runner.indexOf('  phase1) phase1'));
    expect(cancelCase.indexOf('write_state failed_cancelled_operation_failed')).toBeLessThan(cancelCase.indexOf('systemctl_cancel stop'));
    expect(cancelCase).not.toContain('agent_event');
    const unboundedSystemctl = runner.split('\n').filter((line) => {
      if (!/(^|[^A-Za-z_])systemctl(?: |$)/.test(line)) return false;
      return (
        !line.includes('/usr/bin/systemctl "$@"') &&
        !line.includes('-- /usr/bin/systemctl reboot')
      );
    });
    expect(unboundedSystemctl).toEqual([]);
    const unboundedOwnerProbe = runner.split('\n').filter((line) =>
      line.includes('runuser -u matrix -- /opt/matrix/runtime/node/bin/node "$probe"') &&
      !line.includes('command_bounded'),
    );
    expect(unboundedOwnerProbe).toEqual([]);
  });
  it('process-group-bounds production acceptance probes and reports missing roles', async () => {
    const runner = await readRepo('scripts/spikes/terminal-runtime/production-acceptance.sh');
    expectAll(runner, [
      'command_bounded() {', '/usr/bin/setsid "$@" </dev/null &', 'kill -TERM -- "-$operation_pid"', 'kill -KILL -- "-$operation_pid"',
      'systemctl_read() { command_bounded 8 /usr/bin/systemctl "$@"; }', 'owner_probe() { command_bounded 70 runuser -u matrix --',
      'roles() { command_bounded 8 runuser -u matrix --', 'request_update() { command_bounded 70 runuser -u matrix --',
      'zellij() { command_bounded 30 runuser -u matrix --', '/usr/bin/setsid runuser -u matrix -- /opt/matrix/runtime/node/bin/node \\',
      'stop_process_group "$attach_parent_one"', 'stop_process_group "$attach_parent_two"', 'role_failure=agent_unavailable',
      'role_failure=shell_unavailable', 'role_failure=roles_unavailable', 'role_failure=roles_unstable', 'failure_hint="$role_failure"',
    ]);
    expect(runner).not.toContain('/usr/bin/timeout --signal=TERM --kill-after=5s 70s runuser');
    const boundedFunction = runner.match(/command_bounded\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(boundedFunction).toBeDefined();
    const completed = spawnSync(
      '/bin/bash',
      [
        '-c',
        `${boundedFunction}\ncommand_bounded 1 /bin/bash -c '(trap "" HUP TERM; sleep 30) & exit 0'`,
      ],
      { encoding: 'utf8', timeout: 2_500 },
    );
    expect(completed.error).toBeUndefined(); expect(completed.status).toBe(0);
    const timedOut = spawnSync(
      '/bin/bash',
      [
        '-c',
        `${boundedFunction}\ncommand_bounded 1 /bin/bash -c 'trap "" HUP TERM; sleep 30'`,
      ],
      { encoding: 'utf8', timeout: 2_500 },
    );
    expect(timedOut.error).toBeUndefined(); expect(timedOut.status).toBe(124);
  });
  it('fails closed on incomplete, stale, or extended production evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-production-evidence-'));
    roots.push(root);
    const head = 'a'.repeat(40);
    const verifier = join(
      process.cwd(),
      'scripts/spikes/terminal-runtime/verify-production-evidence.mjs',
    );
    const verify = (expectedHead: string) =>
      spawnSync(process.execPath, [verifier, root, '--expected-head', expectedHead]).status;
    const summary = {
      schemaVersion: 1,
      prHeadSha: head,
      status: 'pass',
      zellijBinarySha256:
        '534455dc62c8e3753918d012547d10159ee07929f570a5873a754957502a49c4',
      checks: productionChecks,
      privacyScan: { status: 'pass', findings: 0 },
    };
    await writeFile(join(root, 'summary.json'), `${JSON.stringify(summary)}\n`);
    expect(verify(head)).toBe(0);
    const missing = structuredClone(summary);
    delete missing.checks.bundleTwoPreservesRuntime;
    await writeFile(join(root, 'summary.json'), `${JSON.stringify(missing)}\n`);
    expect(verify(head)).not.toBe(0);
    await writeFile(join(root, 'summary.json'), `${JSON.stringify({
      ...summary,
      extra: true,
    })}\n`);
    expect(verify(head)).not.toBe(0);
    await writeFile(join(root, 'summary.json'), `${JSON.stringify(summary)}\n`);
    expect(verify('b'.repeat(40))).not.toBe(0);
  });
  it('keeps every embedded spike asset inside the immutable-manifest path contract', async () => {
    const assetRoot = join(process.cwd(), 'scripts/spikes/terminal-runtime');
    const paths = await readdir(assetRoot, { recursive: true });
    expect(paths).not.toHaveLength(0);
    expect(paths.filter((path) => !/^[A-Za-z0-9._/-]+$/.test(path))).toEqual([]);
  });
  it('detaches the spike from the gateway cgroup and waits for completed evidence', async () => {
    const [workflow, launcher, packer, runner, attachProbe, zellijDeleteClient, keeper, recordOutcome, recordRuntimeRoles, paneProbe, spec] = await Promise.all([
      readFile(join(process.cwd(), '.github/workflows/terminal-runtime-spikes.yml'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/launch-remote.sh'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/pack-evidence.sh'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/run-remote.sh'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/attach-probe.mjs'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/zellij-delete-client.mjs'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/keeper.mjs'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/record-outcome.mjs'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/record-runtime-roles.mjs'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/pane-probe.sh'), 'utf8'),
      readFile(join(process.cwd(), 'specs/109-persist-terminal-sessions/spec.md'), 'utf8'),
    ]);
    expect(workflow).toContain('/opt/matrix/bin/matrix-terminal-spike-control');
    expect(workflow).not.toContain('/opt/matrix/app/scripts/spikes');
    expect(workflow).toContain('evidence_deadline=$((SECONDS + 2100))');
    expect(workflow).toContain('"$EVIDENCE" --report-gates');
    expect(workflow).toContain('--unpack "$envelope" "$evidence_parent" "$HEAD_SHA"');
    expect(workflow).not.toContain('tar --extract');
    expect(workflow).not.toContain('REMOTE_STATUS:');
    expectAll(workflow, ['test("^(?:spike|evidence)_[a-z0-9_]+\\\\n?$")', 'elif .timedOut == true then "spike_pack_command_timeout"', 'elif .truncated == true then "spike_pack_command_truncated"', 'elif .exitCode != 0 then "spike_pack_command_failed"', 'spike_pack_evidence_(?:incomplete|failed)_[a-z0-9_]+', 'spike_pack_evidence_incomplete_[a-z0-9_]+_stalled_base_[a-z0-9_]+']);
    expect(workflow).toContain('spike_pack_evidence_failed_[a-z0-9_]+');
    expect(workflow).toContain(
      'if [ "$diagnostic" = spike_pack_command_failed ]; then',
    );
    expect(workflow).not.toContain(
      'spike_pack_evidence_incomplete_[a-z0-9_]+_(descriptor|launch|cgroup|readiness|notify)',
    );
    expect(launcher).toContain('systemd-run');
    expect(launcher).toContain('--collect');
    expect(launcher).toContain('--no-block');
    expect(launcher).toContain('--property=RuntimeMaxSec=2400');
    expect(launcher).toContain(
      "list-units --all --plain --no-legend 'matrix-terminal-runtime-spike-*.service'",
    );
    expect(launcher).toContain(
      '[[ "$stale_unit" =~ ^matrix-terminal-runtime-spike-[0-9a-f]{31}\\.service$ ]]',
    );
    expect(launcher).toContain(
      '/usr/bin/timeout --signal=TERM --kill-after=2s 35s systemctl stop "$stale_unit"',
    );
    expect(launcher).toContain('StandardOutput=null');
    expect(launcher).toContain('StandardError=null');
    expect(launcher).toContain('unit="matrix-terminal-runtime-spike-${run_namespace}.service"');
    expect(launcher).toContain('summary="/tmp/matrix-terminal-spike-evidence-${pr_head_sha}-${run_nonce}/summary.json"');
    expect(launcher).not.toContain('short_sha=');
    expect(packer).toContain('summary.json');
    expect(packer).toContain('spike_pack_evidence_incomplete_no_root_${state}');
    expect(packer).toContain(
      '${base_state}_${base_substate}_${exec_status}_${failure_stage}_${failure_code}_${progress_stage}',
    );
    expect(packer).toContain('progress-stage.txt');
    expectAll(packer, [
      'keeper_responsive keeper_zellij keeper_shell keeper_agent',
      'r${keeper_responsive}_z${keeper_zellij}_s${keeper_shell}_a${keeper_agent}',
      'spike_pack_evidence_failed_${gate_failures}_${failure_stage}_${failure_code}_f${startup_rollup}_r${failure_responsive}_z${failure_zellij}_s${failure_shell}_a${failure_agent}',
      'const allowed={s1:new Set(',
      's1none_s2none',
      's1${missing.s1.join("_")||"none"}_s2${missing.s2.join("_")||"none"}',
      'progress_started=',
      'progress_age=$((progress_now - progress_started))',
      'progress_stage="stalled_${progress_stage}_${keeper_stage}_${timeout_start}_${restart_count}_${runner_wait}_${base_role}_${base_wait}_${base_cgroup_count}"',
    ]);
    expectAll(runner, [
      'write_progress base_ready',
      'write_progress base_attach',
      'write_progress base_detached',
      'write_progress base_gateway_restart',
      'write_progress base_gateway_crash',
      'write_progress base_shell_restart',
      'write_progress base_stop',
      'write_progress base_stopped',
    ]);
    expect(runner).toContain('for _ in $(seq 1 "$limit"); do');
    expect(runner).not.toContain(
      'deadline=$((SECONDS + (limit + 9) / 10))',
    );
    expect(packer).toContain('^[a-z0-9_]{1,32}$');
    expect(packer).not.toContain('${base_state}_${base_substate}_${exec_status}_${failure_stage}_${failure_code}" >&2');
    expect(packer).toMatch(/verify-evidence\.mjs \\\n\s+"\$evidence_root" --pack "\$pr_head_sha"/);
    expect(packer).not.toContain('tar --create');
    expect(runner).toContain('bounded_wait_child "$attach_parent"');
    expect(runner).not.toContain('wait "$attach_parent" 2>/dev/null || true');
    expect(runner).toContain("trap 'status=$?; cleanup; build_summary; exit $status' EXIT");
    expect(runner).toMatch(
      /trap - EXIT\ncleanup\nwrite_progress summary_build\nbuild_summary\nsummary_status=/,
    );
    expect(runner).not.toMatch(/build_summary\nsummary_status=[\s\S]*trap - EXIT\ncleanup/);
    expect(runner).toContain('write_progress base_start');
    expect(runner).toContain('write_progress base_start_requested');
    expect(runner).toContain('write_progress keeper_loss');
    expect(runner).toContain('write_progress server_loss');
    expect(runner).toContain('write_progress memory_pressure');
    expect(runner).toContain('write_progress recovery_restore');
    expectAll(runner, [
      'write_progress s2_cache_saved',
      'write_progress s2_initial_stopped',
      'write_progress s2_recover_started',
      'write_progress s2_recover_ready',
      'write_progress s2_viewport_checked',
      'write_progress s2_cache_frozen',
      'write_progress s2_restored_stopped',
      'write_progress s2_delete',
    ]);
    expect(runner).toContain('write_progress corruption_fallback');
    expect(runner).toContain('progress-stage.txt');
    expect(runner).toContain('command_bounded 35 /usr/bin/systemctl "$@"');
    expect(runner).not.toContain('systemctl-client.mjs');
    expect(runner).not.toMatch(/(?:timeout[^\\n]*|^)systemctl /m);
    expect(runner).toContain('write_progress startup_cleanup');
    expect(runner).not.toContain('write_progress startup_cleanup\ncleanup\ntrap');
    expect(runner).toContain('write_progress runtime_setup');
    expect(runner).not.toContain('write_progress runtime_cleanup');
    expect(runner).toContain('run_namespace="${pr_head_sha:0:5}${run_id_padded}${run_attempt_padded}"');
    expect(runner).toContain('runtime_root="/run/matrix-terminal-runtime-spikes/$run_namespace"');
    expect(runner).toContain('state_root="$owner_home/system/terminal-runtime-spikes/$run_namespace"');
    expect(runner).not.toContain('runtime_root="/run/matrix-terminal-runtime-spike"');
    expect(runner).not.toContain('system/terminal-runtime-spike/cache');
    expect(runner).toContain('write_progress runtime_dirs');
    expect(runner).toContain('support_root="$source_dir"');
    expect(runner).not.toContain('write_progress support_cleanup');
    expect(runner).not.toContain('support_copy_stages=');
    expect(runner).toContain('write_progress unit_check');
    expect(runner).toContain('write_progress binary_check');
    expect(runner).toContain('write_progress config_dump');
    expect(runner).toContain('write_progress config_check');
    expect(runner).toContain('zellij_setup_bounded setup --dump-config');
    expect(runner).toContain('zellij_setup_bounded setup --check');
    expect(runner).toMatch(
      /zellij_setup_bounded\(\)[\s\S]*?command_bounded 15 runuser -u matrix -- env/,
    );
    expect(runner).toMatch(
      /command_bounded\(\)[\s\S]*?timeout --signal=TERM --kill-after=1s "\$timeout_seconds"/,
    );
    expect(runner).toContain('/usr/bin/setsid /usr/bin/timeout');
    expect(runner).toContain('wait -n -p completed_pid "$operation_pid" "$deadline_pid"');
    expect(runner).toContain('kill -KILL -- "-$operation_pid"');
    expectAll(runner, [
      '[[ -e "$runtime_root" || -L "$runtime_root" || -e "$state_root" || -L "$state_root" ]]',
      'setup_fs_bounded 15 /usr/bin/install -d -o matrix -g matrix -m 0700 "$runtime_root"',
      '/usr/bin/bash "$support_root/pane-probe.sh"',
    ]);
    expect(paneProbe).not.toContain('ZELLIJ_SESSION_NAME');
    expect(keeper).not.toContain('MATRIX_TERMINAL_RUNTIME_ID: runtimeId');
    expect(paneProbe).not.toContain('/proc/self/cgroup');
    expect(paneProbe).not.toContain('pane-release');
    expect(keeper).toContain('const paneReleasePath = `${runtimeRoot}/pane-release/${sessionName}`');
    expect(runner).not.toContain('/usr/bin/chown -R root:root "$support_root.next"');
    expect(runner).not.toContain(
      'setup_fs_bounded 30 /usr/bin/rm -rf -- "$runtime_root"',
    );
    expect(runner).not.toMatch(
      /runuser -u matrix -- env[\s\\\n]+HOME=.*zellij setup --dump-config/,
    );
    expect(runner).toContain('write_progress cleanup_units');
    expect(runner).toContain('write_progress cleanup_sessions');
    expect(runner).toContain(
      'session_inventory="$(zellij_list_bounded 2>/dev/null || true)"',
    );
    for (let cleanupIndex = 0; cleanupIndex <= 6; cleanupIndex += 1) {
      expect(runner).toContain(`cleanup_session_${cleanupIndex}`);
    }
    expect(runner).not.toContain('write_progress cleanup_reset');
    expect(runner).not.toContain('write_progress cleanup_slice');
    expect(runner).toContain('write_progress cleanup_attach');
    expect(runner).toContain('zellij_delete_bounded "${runtime_ids[$cleanup_index]}"');
    expect(runner).toContain(
      'grep -Fxq "matrix-t-${runtime_ids[$cleanup_index]}"',
    );
    expect(runner).toContain('zellij_delete_if_present "$recovery_id"');
    expect(runner).not.toContain('zellij_cmd delete-session');
    expect(runner).not.toContain('while [ "$SECONDS" -lt "$deadline" ] && [ ! -f "$output_path" ]');
    expect(runner).not.toMatch(/\n\s+rm -rf -- "\$operation_dir"/);
    expect(runner).not.toContain('delete_pids+=("$!")');
    expect(runner).not.toContain('( zellij_delete_bounded "$runtime_id"');
    expect(runner).toContain('zellij-delete-client.mjs');
    expect(runner).not.toMatch(/timeout[^\\n]*runuser[^\\n]*zellij delete-session/);
    expect(zellijDeleteClient).toContain("spawn('/usr/bin/runuser'");
    expect(zellijDeleteClient).toContain(
      "['delete-session', `matrix-t-${operation}`, '--force']",
    );
    expect(zellijDeleteClient).toContain("'list-sessions', '--no-formatting'");
    expect(zellijDeleteClient).toContain('const MAX_OUTPUT = 64 * 1024');
    expect(zellijDeleteClient).toContain('detached: true');
    expect(zellijDeleteClient).toContain('worker.unref()');
    expect(zellijDeleteClient).toContain("statSync('/home/matrix/home')");
    expect(zellijDeleteClient).toContain("openSync(launcherPidPath, 'wx', 0o600)");
    expect(zellijDeleteClient).toContain('writeSync(launcherPidHandle, `${worker.pid}\\n`)');
    expect(zellijDeleteClient).toContain('closeSync(launcherPidHandle)');
    expect(zellijDeleteClient).toContain('process.exit(0)');
    expect(zellijDeleteClient).toContain("process.argv[2] === '--request'");
    expect(zellijDeleteClient).toContain('await waitForWorkerResult(worker, timeoutSeconds)');
    expect(zellijDeleteClient).toContain(
      "stdio: useIpc ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore'",
    );
    expect(zellijDeleteClient).toContain('process.send');
    expect(zellijDeleteClient).not.toContain('readFile(resultPath)');
    expect(zellijDeleteClient).toContain('const runIdentity = resultPath.match(resultPathPattern)?.groups');
    expect(zellijDeleteClient).toContain("runIdentity.runId.padStart(20, '0')");
    expect(zellijDeleteClient).toContain('system/terminal-runtime-spikes/${runNamespace}/cache');
    expect(zellijDeleteClient).not.toContain('system/terminal-runtime-spike/cache');
    for (const helper of [attachProbe, keeper, recordOutcome, recordRuntimeRoles]) {
      expect(helper).toContain('terminal-runtime-spikes');
      expect(helper).not.toContain('/run/matrix-terminal-runtime-spike/');
      expect(helper).not.toContain('system/terminal-runtime-spike/');
    }
    expect(paneProbe).not.toContain('terminal-runtime-spike');
    expect(zellijDeleteClient).toContain("for (const signal of ['SIGTERM', 'SIGKILL'])");
    expect(zellijDeleteClient).toContain('process.kill(-workerPid, signal)');
    expect(zellijDeleteClient).toContain('timeoutSeconds > 60');
    expect(zellijDeleteClient).toContain('writeSync(1, result.output)');
    expect(zellijDeleteClient).not.toContain('await stat(');
    expect(runner).toContain('client_pid_path="$operation_dir/client.pid"');
    expect(runner).toContain(
      '/usr/bin/timeout --signal=TERM --kill-after=1s "$((timeout_seconds + 10))s" \\\n'
      + '    /opt/matrix/runtime/node/bin/node \\\n'
      + '    "$source_dir/zellij-delete-client.mjs" \\\n'
      + '    --request "$timeout_seconds"',
    );
    expect(runner).toContain(
      '"$source_dir/zellij-delete-client.mjs" \\\n'
      + '    --request "$timeout_seconds" \\\n'
      + '    "$client_pid_path" \\\n'
      + '    "$output_path" \\\n'
      + '    "$operation"',
    );
    expect(runner).not.toContain('IFS= read -r client_pid <"$client_pid_path"');
    expect(runner).not.toContain(
      'client_pid="$(/opt/matrix/runtime/node/bin/node "$source_dir/zellij-delete-client.mjs"',
    );
    expect(runner).not.toContain('systemctl_bounded reset-failed "${units[@]}"');
    expect(runner).toContain('systemctl_bounded reset-failed matrix-gateway.service');
    expect(runner).toContain('systemctl_bounded start --no-block matrix-gateway.service');
    expect(runner).toContain('wait_main_pid_changed matrix-gateway.service "$gateway_pid" 150');
    expect(runner).toContain(
      'request_runtime_start "${unit_prefix}${runtime_id}.service"',
    );
    expect(runner).toContain('request_runtime_start()');
    expect(runner).toContain('systemctl_value_bounded()');
    expect(runner).toContain('systemctl_bounded start --no-block "$unit"');
    expect(runner).toContain(
      'systemctl_value_bounded "$unit" ActiveState',
    );
    expect(runner).toContain(
      'systemctl_bounded stop --no-block "$base_unit"',
    );
    expect(runner).not.toContain('systemctl stop --no-block "$base_unit"');
    expect(runner).not.toContain('current="$(systemctl show "$unit"');
    expect(runner).not.toContain('main_pid="$(systemctl show "$base_unit"');
    expect(runner).not.toContain(
      'kill -KILL "$(systemctl show "$keeper_unit"',
    );
    expect(runner).toContain(
      'main_pid="$(systemctl_value_bounded "$base_unit" MainPID)"',
    );
    expect(runner).toContain(
      'systemctl_value_bounded "$keeper_unit" MainPID',
    );
    expect(runner).not.toContain(
      'systemctl_bounded start --no-block "${unit_prefix}${runtime_id}.service"',
    );
    expect(runner).not.toContain(
      'systemctl reset-failed "${unit_prefix}${runtime_id}.service"',
    );
    expect(runner).not.toContain(
      'systemctl start --no-block "${unit_prefix}${runtime_id}.service"',
    );
    expect(runner).not.toContain('if systemctl restart matrix-gateway.service');
    expect(runner).not.toContain('if systemctl restart matrix-shell.service');
    expect(runner).not.toContain('systemctl stop "$recovery_unit"');
    expect(runner).not.toContain(
      'systemctl stop "${unit_prefix}${runtime_id}.service"',
    );
    expectAll(runner, [
      'systemctl_bounded stop "${units[@]}"',
      'zellij_delete_bounded "${runtime_ids[$cleanup_index]}" >/dev/null 2>&1 || true',
      'systemctl_bounded cat matrix-terminal-spike.slice matrix-terminal-spike@.service',
    ]);
    expect(runner).not.toContain(
      'systemctl_bounded reset-failed "${units[@]}"',
    );
    expect(runner).not.toContain('systemctl_bounded set-property');
    expect(runner).toContain('--kill-after=1s 5s pkill');
    expect(runner).not.toContain('sleep 2\ncleanup');
    expect(runner).not.toContain('systemctl daemon-reload');
    expect(runner).not.toContain('systemctl is-active');
    expect(runner).toContain(
      'systemctl_bounded show "$base_unit"',
    );
    expect(packer).toContain(
      '/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$base_unit"',
    );
    expect(packer).toContain(
      '/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl is-active',
    );
    expect(packer).not.toContain('state="$(systemctl is-active');
    expect(packer).not.toContain(
      'base_state="$(/usr/bin/timeout 2s systemctl show',
    );
    expect(runner.includes('IFS= read -r readiness <"$readiness_path" || return 1\n  [[ "$readiness" =~ $readiness_regex ]]') && runner.includes('[ "$desired" = active ] && [ -f "$readiness_path" ]; then return 0')).toBe(true);
    expect(runner).not.toContain('cp -aL "$generation_dir/node_modules/node-pty"');
    expect(runner).not.toContain('install -o matrix -g matrix -m 0600 /dev/null "$runtime_root/confirmations/${recovery_id}.pass"');
    expect(runner).toContain('for runtime_id in "${memory_ids[@]}"; do');
    expect(runner).toContain('restore_memory_high');
    expect(runner).toContain(
      'memory_restore_slice_high="$slice_high"',
    );
    expect(runner).toContain(
      'printf \'%s\\n\' 268435456 >"$slice_high_path"',
    );
    expect(runner).toContain(
      'printf \'%s\\n\' 134217728 >"$runtime_high_path"',
    );
    expect(runner).toContain(
      '[[ "$slice_high_path" =~ ^/sys/fs/cgroup/[-A-Za-z0-9_.@/]+/memory\\.high$ ]]',
    );
    expect(runner).toContain(
      'printf \'%s\\n\' "$memory_restore_slice_high" >"$memory_restore_slice_path"',
    );
    expect(spec).toContain(
      'It MUST NOT persist test thresholds through `systemctl set-property`',
    );
    expect(runner).not.toContain('/usr/bin/timeout --signal=TERM --kill-after=2s 15s runuser');
    expect(runner).toContain('wait_file');
    expect(keeper).toContain("cgroupRoles(cgroup.path, descriptor.intent === 'create')");
    expectAll(keeper, [
      'const keeperExecutable = await realpath(fileURLToPath(import.meta.url))',
      'const require = createRequire(keeperExecutable)',
      "throw new Error('native_binding', { cause: error })",
    ]);
    expect(keeper).toContain("stripVTControlCharacters(renderWindow).includes('<ENTER> run')");
    expect(keeper).toContain(
      "(descriptor.intent === 'create' || gateRecorded)",
    );
    expect(keeper).toContain(
      "if (startupAuthorized && responsive && detected && (descriptor.intent === 'create' || gateRecorded))",
    );
    expect(keeper.indexOf('await notifyReady()')).toBeLessThan(keeper.indexOf('await writeReadiness('));
    expect(runner).toContain('confirmations/${recovery_id}.gated');
    const gateProof = runner.indexOf('confirmations/${recovery_id}.gated');
    const stablePaneName = runner.indexOf(
      'action rename-pane --pane-id "$serialized_pane_id" MATRIX_SCROLL_PROBE',
    );
    const recoveredPaneResolution = runner.indexOf('p.title==="MATRIX_SCROLL_PROBE"');
    const safeDismiss = runner.indexOf('action write --pane-id "$serialized_pane_id" 27');
    const heldViewport = runner.indexOf('held_viewport_anchor=');
    expect(gateProof).toBeGreaterThan(-1);
    expect(stablePaneName).toBeGreaterThan(-1);
    expect(recoveredPaneResolution).toBeGreaterThan(gateProof);
    expect(heldViewport).toBeGreaterThan(recoveredPaneResolution);
    expect(heldViewport).toBeLessThan(safeDismiss);
    expect(safeDismiss).toBeGreaterThan(recoveredPaneResolution);
    expect(safeDismiss).toBeGreaterThan(gateProof);
    expect(runner).not.toContain('restored_viewport_anchor=');
    expect(runner).not.toContain('action send-keys --pane-id "$serialized_pane_id" Esc');
    expect(runner).toContain('recovery-resolution.txt');
    expect(runner).toContain('action dump-screen --pane-id "$restored_pane_id"');
    expect(runner).toContain('chown -R root:root "$recovery_cache_dir"');
    expect(runner).toContain(
      'printf \'layout {\\n  pane {\\n\' >"$corrupt_target"',
    );
    expect(runner).not.toContain(
      'printf \'MATRIX_CORRUPT_STATE\\n\' >"$corrupt_target"',
    );
    expect(runner).toContain('stop_runtime_empty() {');
    expect(runner).toContain(
      'if wait_not_active "$recovery_unit" &&\n'
      + '      stop_runtime_empty "$recovery_unit" "$recovery_cgroup"; then\n'
      + '      zellij_delete_if_present "$recovery_id" >/dev/null 2>&1 || true\n'
      + '      rm -rf -- "$recovery_cache_dir"',
    );
    expect(runner).toContain(
      'if stop_runtime_empty "$recovery_unit" "$recovery_cgroup"; then\n'
      + '    zellij_delete_if_present "$recovery_id" >/dev/null 2>&1 || true\n'
      + '    rm -rf -- "$recovery_cache_dir"\n'
      + '    if [ ! -e "$recovery_cache_dir" ]; then mark_pass s2 deletionComplete; fi\n'
      + '  fi',
    );
  });
  it('publishes a detached Zellij delete worker PID without stdout command substitution', async () => {
    const operationRoot = join(
      tmpdir(),
      `matrix-terminal-spike-zellij-delete-${'a'.repeat(40)}-1-1`,
    );
    roots.push(operationRoot);
    const operationDirectory = join(operationRoot, 'op.ABC123');
    await mkdir(operationDirectory, { recursive: true });
    const launcherPidPath = join(operationDirectory, 'client.pid');
    const resultPath = join(operationDirectory, 'result');
    const helper = join(
      process.cwd(),
      'scripts/spikes/terminal-runtime/zellij-delete-client.mjs',
    );
    const launched = spawnSync(
      process.execPath,
      [helper, launcherPidPath, resultPath, 'b'.repeat(32)],
      { encoding: 'utf8', timeout: 2_000 },
    );
    expect(launched.status).toBe(0);
    expect(launched.stdout).toBe('');
    expect((await readFile(launcherPidPath, 'utf8')).trim()).toMatch(/^[1-9][0-9]*$/);
  });
  it('bounds systemctl probes in a directly supervised process group', async () => {
    const runner = await readRepo('scripts/spikes/terminal-runtime/run-remote.sh');
    expect(runner).toContain(
      'command_bounded 35 /usr/bin/systemctl "$@"',
    );
    expect(runner).toContain(
      'command_bounded 5 /usr/bin/systemctl show "$unit" -p "$property" --value',
    );
    expect(runner).toMatch(
      /command_bounded\(\)[\s\S]*?\/usr\/bin\/setsid \/usr\/bin\/timeout[\s\S]*?kill -KILL -- "-\$operation_pid"/,
    );
    expect(runner).not.toContain('systemctl-client.mjs');
  });
  it('reaps fast bounded commands through a deadline race instead of kill-zero polling', async () => {
    const runner = await readRepo('scripts/spikes/terminal-runtime/run-remote.sh');
    expectAll(runner, [
      '/usr/bin/sleep "$((timeout_seconds + 5))" &',
      'deadline_pid=$!',
      'wait -n -p completed_pid "$operation_pid" "$deadline_pid"',
      'if [ "$completed_pid" = "$operation_pid" ]; then',
      'kill "$deadline_pid" 2>/dev/null || true',
      'wait "$deadline_pid" 2>/dev/null || true',
    ]);
    expect(runner).not.toContain('operation_deadline=$((SECONDS + timeout_seconds + 5))');
    expect(runner).not.toMatch(
      /command_bounded\(\)[\s\S]*?while [\s\S]*?kill -0 "\$operation_pid"/,
    );
    const boundedFunction = runner.match(/command_bounded\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(boundedFunction).toBeDefined();
    const completed = spawnSync(
      '/bin/bash',
      ['-c', `${boundedFunction}\ncommand_bounded 1 /usr/bin/printf fast`],
      { encoding: 'utf8', timeout: 2_000 },
    );
    expect(completed.status).toBe(0);
    expect(completed.stdout).toBe('fast');
  });
  it('records and process-group-bounds every production binary probe', async () => {
    const runner = await readRepo('scripts/spikes/terminal-runtime/run-remote.sh');
    expectAll(runner, [
      'write_progress binary_version',
      'write_progress binary_manifest',
      'write_progress binary_digest',
      'write_progress binary_metadata',
      'command_bounded 15 /opt/matrix/bin/zellij --version',
      'command_bounded 5 /usr/bin/sed',
      'command_bounded 5 /usr/bin/sha256sum /opt/matrix/bin/zellij',
      'command_bounded 5 /usr/bin/cmp --silent',
      'command_bounded 15 runuser -u matrix -- env',
    ]);
  });
  it('bounds a complete Zellij request outside the Bash receipt poller', async () => {
    const operationRoot = join(
      tmpdir(),
      `matrix-terminal-spike-zellij-delete-${'d'.repeat(40)}-1-1`,
    );
    roots.push(operationRoot);
    const operationDirectory = join(operationRoot, 'op.GHI789');
    await mkdir(operationDirectory, { recursive: true });
    const launcherPidPath = join(operationDirectory, 'client.pid');
    const resultPath = join(operationDirectory, 'result');
    const helper = join(
      process.cwd(),
      'scripts/spikes/terminal-runtime/zellij-delete-client.mjs',
    );
    const startedAt = Date.now();
    const completed = spawnSync(
      process.execPath,
      [helper, '--request', '1', launcherPidPath, resultPath, '--list'],
      { encoding: 'utf8', timeout: 3_000 },
    );
    expect(completed.status).not.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect((await readFile(launcherPidPath, 'utf8')).trim()).toMatch(/^[1-9][0-9]*$/);
  });
  it('keeps the fixed notify unit shape and accepts readiness from the keeper helper', async () => {
    const [unit, keeper] = await Promise.all([
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/matrix-terminal-spike-template.service'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/keeper.mjs'), 'utf8'),
    ]);
    expect(unit).toContain('Type=notify\nNotifyAccess=all\n');
    expect(unit).not.toContain('After=matrix-terminal-spike.slice');
    expect(unit).toContain('ExecStart=/opt/matrix/runtime/node/bin/node /opt/matrix/libexec/terminal-runtime/current/spikes/keeper.mjs %i');
    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain('Restart=no');
    expect(unit).not.toContain('EnvironmentFile=');
    expect(unit).not.toContain('[Install]');
    expect(keeper).toContain("!process.cmdline.includes('list-sessions')");
    expect(keeper).toContain("const sessionQueryWorkerMode = process.argv[2] === '--session-query-worker'");
    expect(keeper).toContain("spawnProcess(process.execPath, [keeperExecutable, '--session-query-worker', runtimeId]");
    expect(keeper).toContain("process.kill(-pid, 'SIGKILL')");
    expect(keeper).toContain("stdio: ['ignore', 'ignore', 'ignore', 'ipc']");
    expect(keeper).toContain("spawnProcess(zellij, ['list-sessions', '--no-formatting']");
    expect(keeper).toContain('startupWatchdog = setTimeout');
    expect(keeper).toContain("void failStartup('readiness_timeout')");
    expect(keeper).toContain(
      "paneReleased && responsive && descriptor.intent === 'create' && !workloadPaneLaunched",
    );
    expect(keeper).not.toContain(
      "paneReleased && gateRecorded && descriptor.intent === 'create'",
    );
    expect(keeper).not.toContain("descriptor.intent === 'recover' && !confirmationSent");
    expect(keeper).not.toContain('--force-run-commands');
    expect(keeper).toContain('await launchCreateWorkloadPane(sessionName, env)');
    expect(keeper).toContain('function startupSnapshot()');
    expect(keeper).toContain('gateRecorded,');
    expect(keeper).toContain('paneReleased: paneReleasedRecorded,');
    expect(keeper).toContain('confirmationState,');
    expect(keeper).toContain('heldPaneCount,');
    expect(keeper).toContain('...startupSnapshot()');
    expect(keeper).not.toContain("stdio: ['ignore', handle.fd, 'ignore']");
    expect(keeper.indexOf('const responsive = startupAuthorized')).toBeLessThan(
      keeper.indexOf('const detected = startupAuthorized'),
    );
    expect(keeper.indexOf('const detected = startupAuthorized')).toBeLessThan(
      keeper.indexOf('await recordStartupStage();\n    if (startupAuthorized && responsive && detected'),
    );
  });
  it('fails a stalled startup quickly with monotonic keeper diagnostics', async () => {
    const [launcher, packer, runner, keeper] = await Promise.all([
      readRepo('scripts/spikes/terminal-runtime/launch-remote.sh'),
      readRepo('scripts/spikes/terminal-runtime/pack-evidence.sh'),
      readRepo('scripts/spikes/terminal-runtime/run-remote.sh'),
      readRepo('scripts/spikes/terminal-runtime/keeper.mjs'),
    ]);
    expect(launcher).toContain('--property=Restart=no');
    expect(runner).toContain('"$runtime_root/startup-stages"');
    expect(runner).toContain(
      'command_bounded 20 /opt/matrix/runtime/node/bin/node \\\n'
      + '    "$source_dir/build-evidence.mjs"',
    );
    expect(runner).toContain('systemctl_bounded stop --no-block "$base_unit"');
    expect(keeper).toContain('async function recordStartupStage()');
    expect(keeper).toContain('await recordStartupStage();');
    expect(keeper).toContain('startup-stages/${runtimeId}.json');
    expect(packer).toContain('/proc/uptime');
    expect(packer).toContain('ActiveEnterTimestampMonotonic');
    expect(packer).toContain('-p MainPID --value');
    expect(packer).toContain('/proc/${runner_pid}/wchan');
    expect(packer).toContain('/proc/${base_pid}/wchan');
    expect(packer).toContain('/proc/${base_pid}/comm');
    expect(packer).toContain('TimeoutStartUSec');
    expect(packer).toContain('NRestarts');
    expectAll(packer, [
      'base_id="1${run_namespace}"',
      'runner_unit="matrix-terminal-runtime-spike-${run_namespace}.service"',
    ]);
    expect(packer).toContain('startup-stages/${base_id}.json');
    expect(packer).toContain('keeper_gate keeper_release keeper_confirmation keeper_held');
    expect(packer).toContain('_g${keeper_gate}_p${keeper_release}_c${keeper_confirmation}_h${keeper_held}');
    expect(packer).toContain('stalled_${progress_stage}_${keeper_stage}_${timeout_start}_${restart_count}_${runner_wait}_${base_role}_${base_wait}_${base_cgroup_count}');
    expect(packer).toContain('/usr/bin/stat -c %Y "$progress_path"');
    expect(packer).toContain('/usr/bin/date +%s');
    expect(packer).toContain('${base_role}_${base_wait}_${base_cgroup_count}');
    expect(packer).toContain('${progress_stage}_${keeper_stage}_${timeout_start}_${restart_count}_${runner_wait}_${base_role}_${base_wait}_${base_cgroup_count}');
  });
  it('preserves the last work stage and reports every attempt-scoped startup failure', async () => {
    const [packer, runner] = await Promise.all([
      readRepo('scripts/spikes/terminal-runtime/pack-evidence.sh'),
      readRepo('scripts/spikes/terminal-runtime/run-remote.sh'),
    ]);
    expectAll(runner, [
      'last-work-stage.txt',
      'last-work-uptime.txt',
      'case "$progress_stage" in',
      'cleanup_units|cleanup_sessions|cleanup_session_[0-6]|cleanup_attach) ;;',
    ]);
    expectAll(packer, [
      'runtime_ids=("$base_id" "$keeper_id" "$server_id" "${memory_ids[@]}" "$recovery_id")',
      'startup_failure_rollup() {',
      'startup-failures/${runtime_id}.json',
      'last-work-stage.txt',
      'startup_rollup="$(startup_failure_rollup)"',
      '_f${startup_rollup}_',
    ]);
    expect(packer).toContain('[[ "$startup_rollup" =~ ^[a-z0-9_]{1,1024}$ ]]');
    expect(
      packer.indexOf('failure_progress_path="$evidence_root/last-work-stage.txt"'),
    ).toBeLessThan(
      packer.indexOf('failure_progress_path="$evidence_root/progress-stage.txt"'),
    );
  });
  it('activates the aggregate slice before starting the first template instance', async () => {
    const runner = await readRepo('scripts/spikes/terminal-runtime/run-remote.sh');
    const sliceStart = runner.indexOf(
      'systemctl_bounded start matrix-terminal-spike.slice',
    );
    const sliceCheck = runner.indexOf(
      'systemctl_value_bounded matrix-terminal-spike.slice ActiveState',
    );
    const runtimeStartDefinition = runner.indexOf('start_runtime() {');
    const descriptorPublish = runner.indexOf('descriptor "$runtime_id" "$intent"');
    const runtimeStartRequest = runner.indexOf(
      'request_runtime_start "${unit_prefix}${runtime_id}.service"',
    );
    const firstRuntimeStart = runner.indexOf('start_runtime "$base_id"');
    const releaseProgress = runner.indexOf('write_progress base_release');
    const boundedPaneRelease = runner.indexOf(
      'setup_fs_bounded 5 /usr/bin/install -o root -g root -m 0644 /dev/null',
    );
    const paneReleaseCall = runner.indexOf('release_pane "$base_id"');
    const waitProgress = runner.indexOf('write_progress base_wait_ready');
    const firstRuntimeWait = runner.indexOf('wait_state "$base_unit" active');
    expect(sliceStart).toBeGreaterThan(-1);
    expect(sliceCheck).toBeGreaterThan(sliceStart);
    expect(descriptorPublish).toBeGreaterThan(runtimeStartDefinition);
    expect(runtimeStartRequest).toBeGreaterThan(descriptorPublish);
    expect(firstRuntimeStart).toBeGreaterThan(sliceCheck);
    expect(releaseProgress).toBeGreaterThan(firstRuntimeStart);
    expect(boundedPaneRelease).toBeGreaterThan(-1);
    expect(paneReleaseCall).toBeGreaterThan(releaseProgress);
    expect(waitProgress).toBeGreaterThan(paneReleaseCall);
    expect(firstRuntimeWait).toBeGreaterThan(waitProgress);
  });
  it('accepts complete bounded S1 and S2 evidence', async () => {
    const root = await evidence();
    await expect(validateEvidenceDirectory(root)).resolves.toMatchObject({
      prHeadSha: 'a'.repeat(40),
      s1: { status: 'pass' },
      s2: { status: 'pass' },
      fileCount: 1,
    });
  });
  it('packs and exclusively materializes only exact-head bounded evidence', async () => {
    const headSha = 'a'.repeat(40);
    const root = await evidence();
    const envelope = await packEvidenceDirectory(root, headSha);
    const envelopeRoot = await mkdtemp(join(tmpdir(), 'matrix-terminal-envelope-'));
    roots.push(envelopeRoot);
    const envelopePath = join(envelopeRoot, 'evidence.json');
    await writeFile(envelopePath, JSON.stringify(envelope), 'utf8');
    const outputRoot = await mkdtemp(join(tmpdir(), 'matrix-terminal-unpack-'));
    roots.push(outputRoot);
    const unpacked = await unpackEvidenceEnvelope(envelopePath, outputRoot, headSha);
    await expect(validateEvidenceDirectory(unpacked, headSha)).resolves.toMatchObject({
      prHeadSha: headSha,
      fileCount: 1,
    });
    await expect(unpackEvidenceEnvelope(envelopePath, outputRoot, headSha)).rejects.toThrow(
      'evidence_output_exists',
    );
  });
  it('rejects stale heads and unsafe envelope paths before writing evidence', async () => {
    const headSha = 'a'.repeat(40);
    const root = await evidence();
    await expect(validateEvidenceDirectory(root, 'b'.repeat(40))).rejects.toThrow(
      'evidence_head_mismatch',
    );
    const envelope = await packEvidenceDirectory(root, headSha);
    envelope.files[0].path = '../outside';
    const envelopeRoot = await mkdtemp(join(tmpdir(), 'matrix-terminal-envelope-'));
    roots.push(envelopeRoot);
    const envelopePath = join(envelopeRoot, 'evidence.json');
    await writeFile(envelopePath, JSON.stringify(envelope), 'utf8');
    const outputRoot = await mkdtemp(join(tmpdir(), 'matrix-terminal-unpack-'));
    roots.push(outputRoot);
    await expect(unpackEvidenceEnvelope(envelopePath, outputRoot, headSha)).rejects.toThrow(
      'evidence_file_path',
    );
    await expect(readFile(join(outputRoot, 'outside'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a missing or failed mandatory check', async () => {
    const root = await evidence({
      s1: {
        status: 'fail',
        checks: { ...s1Checks, stopEmptiesCgroup: false },
      },
    });
    await expect(validateEvidenceDirectory(root)).rejects.toThrow('evidence_gate_failed');
  });
  it('reports only allowlisted gate names for rejected evidence', async () => {
    const root = await evidence({
      s1: {
        status: 'fail',
        checks: { ...s1Checks, stopEmptiesCgroup: false, injectedSecret: 'do-not-log' },
      },
    });
    await writeFile(
      join(root, 's1', 'base-startup-failure.json'),
      `${JSON.stringify({ stage: 'readiness', code: 'client_exit', gateRecorded: false, paneReleased: true, confirmationState: 'not_required', heldPaneCount: 0, confirmationSent: false, responsive: false, zellij: 1, shell: false, agent: false, exitCode: 1, signal: 0 })}\n`,
      'utf8',
    );
    await writeFile(
      join(root, 's1', 'base-startup-unit.txt'),
      'ActiveState=failed\nSubState=failed\nResult=timeout\nExecMainCode=1\nExecMainStatus=16\n',
      'utf8',
    );
    await writeFile(
      join(root, 's1', 'base-runtime-roles.json'),
      `${JSON.stringify({
        checkpoint: 'initial', keeper: true, zellijAlive: 1,
        zellijExpected: 2, shell: true, agent: false,
      })}\n`,
      'utf8',
    );
    await mkdir(join(root, 's2'));
    await writeFile(
      join(root, 's2', 'recovery-startup-failure.json'),
      `${JSON.stringify({ stage: 'readiness', code: 'readiness_timeout', gateRecorded: true, paneReleased: true, confirmationState: 'gated', heldPaneCount: 0, confirmationSent: false, responsive: true, zellij: 2, shell: true, agent: false })}\n`,
      'utf8',
    );
    await writeFile(join(root, 's1', 'memory-stage.txt'), 'slice_no_pressure\n', 'utf8');
    await writeFile(join(root, 'preflight-stage.txt'), 'binary_version_checked\n', 'utf8');
    await writeFile(
      join(root, 's2', 'binary-digest.txt'),
      `expected=${'a'.repeat(64)}\nactual=${'b'.repeat(64)}\n`,
      'utf8',
    );
    await writeFile(
      join(root, 's2', 'recovery-resolution.txt'),
      'original_pane_id=2\nrecovered_pane_id=1\nrecovered_pane_count=2\nheld_pane_count=2\nsafe_drop_status=0\npost_drop_markers=9999\n',
      'utf8',
    );
    await expect(reportGateChecks(root)).resolves.toEqual([
      's1:stopEmptiesCgroup=fail',
      's1:startup=readiness/client_exit/gate:0/release:1/confirmation:not_required/held:0/sent:0',
      's1:pty-exit=1/0',
      's1:unit=failed/failed/timeout/1/16',
      's1:roles=initial/keeper:1/zellij:1of2/shell:1/agent:0',
      's2:recovery=readiness/readiness_timeout/gate:1/release:1/confirmation:gated/held:0/sent:0/roles:1,2,1,0',
      's2:resolution=original:2/recovered:1/panes:2/held:2/drop:0/markers:9999',
      's1:memory=slice_no_pressure',
      'spike:preflight=binary_version_checked',
      `s2:binary=expected:${'a'.repeat(64)}/actual:${'b'.repeat(64)}`,
    ]);
    await rm(join(root, 's1', 'base-runtime-roles.json'));
    await symlink('/etc/passwd', join(root, 's1', 'base-runtime-roles.json'));
    await expect(reportGateChecks(root)).resolves.toEqual([
      's1:stopEmptiesCgroup=fail',
      's1:startup=readiness/client_exit/gate:0/release:1/confirmation:not_required/held:0/sent:0',
      's1:pty-exit=1/0', 's1:unit=failed/failed/timeout/1/16',
      's2:recovery=readiness/readiness_timeout/gate:1/release:1/confirmation:gated/held:0/sent:0/roles:1,2,1,0',
      's2:resolution=original:2/recovered:1/panes:2/held:2/drop:0/markers:9999',
      's1:memory=slice_no_pressure',
      'spike:preflight=binary_version_checked',
      `s2:binary=expected:${'a'.repeat(64)}/actual:${'b'.repeat(64)}`,
    ]);
  });
  it('rejects a binary other than the exact patched Zellij build', async () => {
    const root = await evidence({ zellijVersion: 'zellij 0.44.1' });
    await expect(validateEvidenceDirectory(root)).rejects.toThrow('evidence_zellij_version');
    const wrongPatch = await evidence({
      zellijBuild: {
        buildId: 'v0.44.3-matrix.2',
        sourceVersion: '0.44.3',
        sourceSha256: '33ae61fc802b59462fed49b424893596d3aa819646bdce53d5602f714c1264fe',
        patchSha256: 'c676df6a455cb508920397d7b9f7490b855e7212b42105247cf41269d466e6bf',
        rustVersion: '1.92.0',
        target: 'x86_64-unknown-linux-musl',
        sourceDateEpoch: 1735689600,
        pathRemap: '/usr/src/matrix-zellij',
        builder: 'github-actions-ubuntu-24.04',
        workRoot: '/tmp/matrix-zellij-build-v0.44.3-matrix.1',
        binarySha256: '534455dc62c8e3753918d012547d10159ee07929f570a5873a754957502a49c4',
      },
    });
    await expect(validateEvidenceDirectory(wrongPatch)).rejects.toThrow('evidence_zellij_build');
  });
  it('rejects traversal and symlink evidence entries', async () => {
    const traversalRoot = await evidence({
      files: [{ path: '../outside', bytes: 1, sha256: '0'.repeat(64) }],
      totalBytes: 1,
    });
    await expect(validateEvidenceDirectory(traversalRoot)).rejects.toThrow('evidence_file_path');
    const symlinkRoot = await evidence();
    await rm(join(symlinkRoot, 's1', 'processes.json'));
    await symlink('/etc/passwd', join(symlinkRoot, 's1', 'processes.json'));
    await expect(validateEvidenceDirectory(symlinkRoot)).rejects.toThrow('evidence_file_type');
  });
  it('rejects hard-linked and unlisted evidence files', async () => {
    const hardLinkRoot = await evidence();
    await link(
      join(hardLinkRoot, 's1', 'processes.json'),
      join(hardLinkRoot, 's1', 'processes-hard-link.json'),
    );
    await expect(validateEvidenceDirectory(hardLinkRoot)).rejects.toThrow('evidence_file_type');
    const unlistedRoot = await evidence();
    await writeFile(join(unlistedRoot, 'unlisted.txt'), 'unexpected\n', 'utf8');
    await expect(validateEvidenceDirectory(unlistedRoot)).rejects.toThrow('evidence_unlisted_file');
  });
  it('rejects oversized files before reading their contents', async () => {
    const root = await evidence();
    const body = 'x'.repeat(MAX_EVIDENCE_FILE_BYTES + 1);
    await writeFile(join(root, 's1', 'processes.json'), body, 'utf8');
    await expect(validateEvidenceDirectory(root)).rejects.toThrow('evidence_file_size');
  });
  it.each([
    'authorization: Bearer abcdef',
    'token=super-secret-value',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'host=203.0.113.10',
    'cwd=/home/matrix/home/projects/private',
  ])('rejects sensitive evidence content: %s', async (secret) => {
    const root = await evidence();
    const body = `${secret}\n`;
    await writeFile(join(root, 's1', 'processes.json'), body, 'utf8');
    const summaryPath = join(root, 'summary.json');
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    summary.files[0] = {
      path: 's1/processes.json',
      bytes: Buffer.byteLength(body),
      sha256: createHash('sha256').update(body).digest('hex'),
    };
    summary.totalBytes = Buffer.byteLength(body);
    await writeFile(summaryPath, `${JSON.stringify(summary)}\n`, 'utf8');
    await expect(validateEvidenceDirectory(root)).rejects.toThrow('evidence_privacy');
  });
  it('rejects digest and declared-size mismatches', async () => {
    const root = await evidence();
    await writeFile(join(root, 's1', 'processes.json'), '{}\n', 'utf8');
    await expect(validateEvidenceDirectory(root)).rejects.toThrow('evidence_file_metadata');
  });
});
