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
rebootStartsNoRuntime rebootShowsInterrupted explicitRecoverRestoresRuntime concurrentRecoverSingleUnit corruptionFallsBackFresh recoverDeleteCannotResurrect deleteWaitsForEmptyCgroup deleteRemovesRecoveryState`);
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
      '/usr/bin/timeout --signal=TERM --kill-after=1s 5s \\',
      '/usr/bin/sed -nE',
      'IFS= read -r expected_zellij_binary_sha256 <&9',
      'read -r zellij_binary_sha256 digest_path digest_extra <"$actual_digest_file"',
      'rm -rf -- "$evidence_root" "$runtime_root" "$cache_root" "$config_root" "$config_home_root" "$data_root"']);
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
    expect(workflow).not.toContain('VPS_SSH_KEY');
    expect(workflow).toContain('workflow_dispatch:');
  });
  it('can remove only its immutable disposable preview before a clean proof', async () => {
    const workflow = await readFile(
      join(process.cwd(), '.github/workflows/terminal-runtime-spikes.yml'),
      'utf8',
    );
    expectAll(workflow, ["github.event.label.name == 'terminal-preview-reprovision'", 'any(.name == "terminal-preview-reprovision")',
      'if length == 1 then .[0].machineId else error("preview_unavailable") end', '-X DELETE "${PLATFORM_PUBLIC_URL%/}/vps/${machine_id}"']);
  });
  it('packages the harness only for explicitly marked preview bundles', async () => {
    const [buildScript, previewWorkflow] = await Promise.all([
      readFile(join(process.cwd(), 'scripts/build-host-bundle.sh'), 'utf8'),
      readFile(join(process.cwd(), '.github/workflows/preview-vps.yml'), 'utf8'),
    ]);
    expect(previewWorkflow).toContain("MATRIX_TERMINAL_RUNTIME_SPIKE: '1'");
    expect(buildScript).toContain('if [ "${MATRIX_TERMINAL_RUNTIME_SPIKE:-0}" = "1" ]; then');
    expect(buildScript).toContain('chmod 0755 "$terminal_generation_build/spikes/"{launch-remote,pack-evidence,run-remote,production-acceptance}.sh');
    expectAll(buildScript, ['matrix-terminal-spike.slice" "$STAGE_DIR/systemd/matrix-terminal-spike.slice"', 'matrix-terminal-spike-template.service" "$STAGE_DIR/systemd/matrix-terminal-spike@.service"']);
  });
  it('requires an exact-head production acceptance matrix beyond S1 and S2', async () => {
    const [workflow, helper, runner, verifier] = await Promise.all([
      readRepo('.github/workflows/terminal-runtime-production-acceptance.yml'),
      readRepo('distro/customer-vps/host-bin/matrix-terminal-spike-control'), readRepo('scripts/spikes/terminal-runtime/production-acceptance.sh'),
      readRepo('scripts/spikes/terminal-runtime/verify-production-evidence.mjs'),
    ]);
    expectAll(workflow, ["github.event.label.name == 'terminal-production-acceptance'", 'timeout-minutes: 360', 'deadline=$((SECONDS + 18000))',
      'call_helper acceptance-launch', 'call_helper acceptance-reboot', 'call_helper acceptance-resume',
      'call_helper acceptance-pack', 'Validate the complete production matrix']);
    expect(runner).toContain('for _ in $(seq 1 4500)');
    expect(workflow).not.toMatch(/^\s+env:\n\s+env:/m);
    expectAll(helper, ['acceptance-launch | acceptance-status | acceptance-reboot | acceptance-resume | acceptance-pack', 'exec /usr/bin/bash "$target"']);
    expect(helper).not.toContain('[ ! -x "$target" ]');
    for (const check of `bundleOnePreservesRuntime bundleTwoPreservesRuntime failedUpdatePreservesRuntime explicitRollbackPreservesRuntime rebootStartsNoRuntime
explicitRecoverRestoresRuntime concurrentRecoverSingleUnit recoverDeleteCannotResurrect corruptionFallsBackFresh deleteWaitsForEmptyCgroup`.split(/\s+/)) {
      expect(runner).toContain(check);
      expect(verifier).toContain(check);
    }
    expect(runner).toContain("pgrep -a zellij | grep -F -- '--force-run-commands'");
    expect(runner).not.toMatch(/zellij(?:_cmd)?\s[^|\n]*--force-run-commands/);
    expect(workflow).not.toContain('VPS_SSH_KEY');
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
    const [workflow, launcher, packer, runner, attachProbe] = await Promise.all([
      readFile(join(process.cwd(), '.github/workflows/terminal-runtime-spikes.yml'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/launch-remote.sh'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/pack-evidence.sh'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/run-remote.sh'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/attach-probe.mjs'), 'utf8'),
    ]);
    expect(workflow).toContain('/opt/matrix/bin/matrix-terminal-spike-control');
    expect(workflow).not.toContain('/opt/matrix/app/scripts/spikes');
    expect(workflow).toContain('evidence_deadline=$((SECONDS + 2100))');
    expect(workflow).toContain('"$EVIDENCE" --report-gates');
    expect(workflow).toContain('--unpack "$envelope" "$evidence_parent" "$HEAD_SHA"');
    expect(workflow).not.toContain('tar --extract');
    expect(workflow).not.toContain('REMOTE_STATUS:');
    expectAll(workflow, ['test("^(?:spike|evidence)_[a-z0-9_]+\\\\n?$")', 'elif .timedOut == true then "spike_pack_command_timeout"', 'elif .truncated == true then "spike_pack_command_truncated"', 'elif .exitCode != 0 then "spike_pack_command_failed"', 'spike_pack_evidence_incomplete_[a-z0-9_]+_(descriptor|launch|cgroup|readiness|notify)_[a-z0-9_]+']);
    expect(launcher).toContain('systemd-run');
    expect(launcher).toContain('--collect');
    expect(launcher).toContain('--no-block');
    expect(launcher).toContain('--property=RuntimeMaxSec=1800');
    expect(launcher).toContain('StandardOutput=null');
    expect(launcher).toContain('StandardError=null');
    expect(launcher).toContain('unit="matrix-terminal-runtime-spike-${pr_head_sha}.service"');
    expect(launcher).toContain('summary="/tmp/matrix-terminal-spike-evidence-${pr_head_sha}/summary.json"');
    expect(launcher).not.toContain('short_sha=');
    expect(packer).toContain('summary.json');
    expect(packer).toContain('spike_pack_evidence_incomplete_no_root_${state}');
    expect(packer).toContain('${base_state}_${base_substate}_${exec_status}_${failure_stage}_${failure_code}');
    expect(packer).not.toContain('${base_state}_${base_substate}_${exec_status}_${failure_stage}_${failure_code}" >&2');
    expect(packer).toMatch(/verify-evidence\.mjs \\\n\s+"\$evidence_root" --pack "\$pr_head_sha"/);
    expect(packer).not.toContain('tar --create');
    expect(runner).toContain('bounded_wait_child "$attach_parent"');
    expect(runner).not.toContain('wait "$attach_parent" 2>/dev/null || true');
    expect(runner).toContain("trap 'status=$?; build_summary; cleanup; exit $status' EXIT");
    expectAll(runner, ['/usr/bin/timeout --signal=TERM --kill-after=2s 35s systemctl stop', 'systemctl stop "${units[@]}"', 'delete_pids+=("$!")', 'for child in "${delete_pids[@]}"; do wait "$child" || true; done', 'systemctl cat matrix-terminal-spike.slice matrix-terminal-spike@.service']);
    expect(runner).toContain('--kill-after=1s 5s systemctl reset-failed');
    expect(runner).toContain('--kill-after=1s 5s systemctl set-property');
    expect(runner).toContain('--kill-after=1s 5s pkill');
    expect(runner).not.toContain('sleep 2\ncleanup');
    expect(runner).not.toContain('systemctl daemon-reload');
    expect(runner).not.toContain('systemctl is-active');
    expect(runner).toContain('/usr/bin/timeout 5s systemctl show "$base_unit"');
    expect(runner.includes('IFS= read -r readiness <"$readiness_path" || return 1\n  [[ "$readiness" =~ $readiness_regex ]]') && runner.includes('[ "$desired" = active ] && [ -f "$readiness_path" ]; then return 0')).toBe(true);
    expect(runner).not.toContain('cp -aL "$generation_dir/node_modules/node-pty"');
    expect(runner).not.toContain('install -o matrix -g matrix -m 0600 /dev/null "$runtime_root/confirmations/${recovery_id}.pass"');
    expect(runner).toContain('for runtime_id in "${memory_ids[@]}"; do');
    expect(runner).toContain('systemctl set-property --runtime');
    expect(runner).toContain('MemoryHigh=75%');
    expect(runner).toContain('/usr/bin/timeout --signal=TERM --kill-after=2s 15s runuser');
    expect(runner).toContain('wait_file');
    const keeper = await readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/keeper.mjs'), 'utf8');
    expect(keeper).toContain("cgroupRoles(cgroup.path, descriptor.intent === 'create')");
    expectAll(keeper, ["createRequire('/opt/matrix/libexec/terminal-runtime/current/package.json')", "throw new Error('native_binding', { cause: error })"]);
    expect(keeper).toContain("stripVTControlCharacters(renderWindow).includes('<ENTER> run')");
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
  });
  it('keeps the fixed notify unit shape and accepts readiness from the keeper helper', async () => {
    const [unit, keeper] = await Promise.all([
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/matrix-terminal-spike-template.service'), 'utf8'),
      readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/keeper.mjs'), 'utf8'),
    ]);
    expect(unit).toContain('Type=notify\nNotifyAccess=all\n');
    expect(unit).toContain('ExecStart=/opt/matrix/runtime/node/bin/node /opt/matrix/libexec/terminal-runtime-spike/keeper.mjs %i');
    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain('Restart=no');
    expect(unit).not.toContain('EnvironmentFile=');
    expect(unit).not.toContain('[Install]');
    expect(keeper).toContain("!process.cmdline.includes('list-sessions')");
    expect([keeper.includes("execFileAsync(zellij, ['list-sessions'"), keeper.includes('detached: true'), keeper.includes("process.kill(-child.pid, 'SIGKILL')"), keeper.includes("stdio: ['ignore', handle.fd, 'ignore']"), keeper.includes("stdio: ['ignore', 'pipe', 'ignore']")]).toEqual([false, true, true, true, false]);
    expect(keeper.indexOf('const detected = await cgroupRoles')).toBeLessThan(keeper.indexOf('const responsive = Boolean(detected && await exactSessionResponds'));
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
      `${JSON.stringify({ stage: 'readiness', code: 'client_exit', confirmationSent: false, responsive: false, zellij: 1, shell: false, agent: false, exitCode: 1, signal: 0 })}\n`,
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
      `${JSON.stringify({ stage: 'readiness', code: 'readiness_timeout', confirmationSent: true, responsive: true, zellij: 2, shell: true, agent: false })}\n`,
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
      's1:startup=readiness/client_exit',
      's1:pty-exit=1/0',
      's1:unit=failed/failed/timeout/1/16',
      's1:roles=initial/keeper:1/zellij:1of2/shell:1/agent:0',
      's2:recovery=readiness/readiness_timeout/confirm:1/roles:1,2,1,0',
      's2:resolution=original:2/recovered:1/panes:2/held:2/drop:0/markers:9999',
      's1:memory=slice_no_pressure',
      'spike:preflight=binary_version_checked',
      `s2:binary=expected:${'a'.repeat(64)}/actual:${'b'.repeat(64)}`,
    ]);
    await rm(join(root, 's1', 'base-runtime-roles.json'));
    await symlink('/etc/passwd', join(root, 's1', 'base-runtime-roles.json'));
    await expect(reportGateChecks(root)).resolves.toEqual([
      's1:stopEmptiesCgroup=fail', 's1:startup=readiness/client_exit',
      's1:pty-exit=1/0', 's1:unit=failed/failed/timeout/1/16',
      's2:recovery=readiness/readiness_timeout/confirm:1/roles:1,2,1,0',
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
