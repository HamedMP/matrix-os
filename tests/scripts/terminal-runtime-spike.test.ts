import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { link, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const productionChecks = passing(`runtimeLive continuousOutput codingAgentPreserved twoDevicesOneRuntime
detachPreservesRuntime renamePreservesIdentity bundleOnePreservesRuntime bundleTwoPreservesRuntime
supervisorPreserved failedUpdatePreservesRuntime explicitRollbackPreservesRuntime daemonReloadPreservesRuntime forceRunAbsent journalPrivacy
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
    expect(builder).toContain('v0.44.3-matrix.1.build.json');
    expect(builder).toContain('cp -- "$candidate_record" "$output_dir/build.json"');
    expect(remoteRunner).toContain(
      'candidate_build_record="$source_dir/v0.44.3-matrix.1.build.json"',
    );
    expect(remoteRunner).not.toContain('/opt/matrix/app');
    expect(remoteRunner).not.toMatch(/\bjq\b/);
    expect(remoteRunner).toContain('record_preflight binary_manifest_read');
    expect(remoteRunner).toContain(
      'rm -rf -- "$evidence_root" "$runtime_root" "$cache_root" "$config_root" "$config_home_root" "$data_root"',
    );
    expect(verifier).toContain('terminal-runtime/zellij/v0.44.3-matrix.1.build.json');
    expect(builder).toContain('ZELLIJ_SOURCE_VERSION="$(jq -er .sourceVersion "$candidate_record")"');
    expect(builder).toContain('cargo test -p zellij-server');
    expect(builder).toContain('serialized_pane_restores_bounded_viewport_offset');
    expect(builder).toContain('ZELLIJ_TARGET="$(jq -er .target "$candidate_record")"');
    expect(builder).toContain('zellij_binary_digest_mismatch');
    expect(builder).toContain('--target "$ZELLIJ_TARGET"');
    expect(builder).toContain('export CARGO_HOME="$work_dir/cargo-home"');
    expect(builder).toContain('work_dir="$ZELLIJ_WORK_ROOT"');
    expect(builder).toContain('mkdir -m 0700 -- "$work_dir"');
    expect(builder).toContain('export CARGO_INCREMENTAL=0');
    expect(builder).toContain('export SOURCE_DATE_EPOCH="$ZELLIJ_SOURCE_DATE_EPOCH"');
    expect(builder).toContain('--remap-path-prefix=$work_dir=$ZELLIJ_PATH_REMAP');
    expect(zellijPatch).toContain('grid_before_banner');
    expect(zellijPatch).toContain('scrollback_lines_to_serialize.saturating_sub(viewport_lines_to_serialize)');
    expect(zellijPatch).toContain('.take(lines_below_to_serialize)');
    expect(zellijPatch).toContain('matrix-zellij-viewport-offset-v1=');
    expect(zellijPatch).toContain('held_resurrected_pane_preserves_viewport_and_history_across_reflow');
    expect(zellijPatch).toContain('serialized_pane_content_is_bounded_including_the_viewport');
    expect(zellijPatch).toContain('serialized_pane_restores_bounded_viewport_offset');
    expect(zellijPatch).toContain('restore_serialized_contents');
    expect(zellijPatch).toContain(
      'command_panes_serialize_initial_contents_for_gated_resurrection',
    );
    expect(zellijPatch).toContain('+        if edit.is_none() {');
    expect(builder).toContain(
      'command_panes_serialize_initial_contents_for_gated_resurrection',
    );
    expect(previewWorkflow).toContain('Build verified production Zellij');
    expect(previewWorkflow).toContain('runs-on: ubuntu-24.04');
    expect(previewWorkflow).toContain('HOST_BUNDLE_ZELLIJ_BUILD_DIR:');
    expect(buildScript).toContain('HOST_BUNDLE_ZELLIJ_BUILD_DIR');
    expect(syncAgent).toContain('zellij_candidate_digest_mismatch');
    expect(syncAgent).toContain('mv -f "$zellij_next" "$BIN_DIR/zellij"');
    expect(syncAgent).toContain('zellij_installed_digest_mismatch');
    expect(syncAgent).toContain("! -name 'zellij'");
    expect(syncAgent).toContain("! -name 'zellij.build.json'");
    expect(syncAgent).toContain("! -name 'matrix-terminal-*'");
    expect(syncAgent).toContain('backup_zellij_for_rollback');
    expect(syncAgent).toContain('restore_zellij_after_rollback');
    expect(syncAgent).toContain('readonly ZELLIJ_ROLLBACK_DIR="$ROLLBACK_STATE_DIR/zellij.rollback"');
    expect(syncAgent).toContain('local rollback_next="${ZELLIJ_ROLLBACK_DIR}.next"');
    expect(syncAgent).toContain('mv -- "$rollback_next" "$ZELLIJ_ROLLBACK_DIR"');
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
    const applyUpdate = syncAgent.slice(syncAgent.indexOf('apply_update()'), syncAgent.indexOf('# ── Rollback'));
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
    expect(syncAgent).toContain(
      'if [ -f "$extract_dir/bin/zellij" ]; then\n        rm -f -- "$ZELLIJ_BUILD_METADATA"',
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
    expect(workflow).toContain('diagnose_only:');
    expect(workflow).toContain('command:["/opt/matrix/bin/matrix-update","diagnose"]');
    expect(workflow).toContain("github.event.label.name == 'terminal-updater-bootstrap'");
    expect(workflow).toContain(
      'command:["/usr/bin/sudo","/usr/bin/systemctl","restart","matrix-sync-agent.service"]',
    );
    expect(workflow).toContain(
      'command:["/opt/matrix/bin/matrix-update","repair"]',
    );
    expect(workflow).toContain('Typed updater repair accepted.');
    expect(workflow).toContain('Legacy disposable updater bootstrap completed.');
    expect(workflow).toContain('Deployment diagnostic never satisfies S1/S2.');
    expect(workflow).toContain('APPROVED_HEAD_SHA: ${{ github.event.pull_request.head.sha || inputs.head_sha }}');
    expect(workflow).toContain('if [ "$head_sha" != "$APPROVED_HEAD_SHA" ]');
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).toContain('.labels | any(.name == "preview-vps")');
    expect(workflow).toContain('PR_NUMBER: ${{ github.event.pull_request.number || inputs.pr }}');
    expect(workflow).toContain('timeout-minutes: 180');
    expect(workflow.split('\n')).toContain('          deadline=$((SECONDS + 4500))');
    expect(workflow).toContain("runtime_version=\"$(jq -r '.runtimeVersion // \"\"' <<<\"$machine\")\"");
    expect(workflow).toMatch(
      /if ! fleet="\$\(curl --fail[\s\S]{0,300}\/vps\/fleet"\)"; then\n\s+echo "Fleet query failed; retrying\." >&2\n\s+sleep 15\n\s+continue\n\s+fi/,
    );
    expect(workflow).toContain('echo "update_diagnostic=${update_diagnostic}"');
    expect(workflow).toContain(
      'test("^Update service: (idle|running|failed) phase=(idle|admitted|resolving|downloading|validating|extracting|preparing|committing|health_check|rollback|failed) failure=(none|[a-z0-9_]{1,64})\\\\n$")',
    );
    expect(workflow).not.toContain("jq -r '.imageVersion // \"\"'");
    expect(workflow).toContain('--resolve "app.matrix-os.com:443:${PUBLIC_IPV4}"');
    expect(workflow).toContain("'https://app.matrix-os.com/api/terminal/run'");
    expect(workflow).toContain('spike_control_deadline=$((SECONDS + 300))');
    expect(workflow).toContain('command:["/opt/matrix/bin/matrix-update","status"]');
    expect(workflow).toContain('.stdout == "Update service: idle\\n"');
    expect(workflow).toContain('echo "update_status=${update_status}" >&2');
    expect(workflow).toContain('spike_launch_deadline=$((SECONDS + 300))');
    expect(workflow).toContain('[ "$diagnostic" = "spike_control_unavailable" ]');
    expect(workflow.match(/--insecure/g)).toHaveLength(4);
    expect(workflow).toContain('PLATFORM_SECRET never leaves the runner');
    expect(workflow.match(/gateway_http_status=\$http_code/g)).toHaveLength(2);
    expect(workflow).toContain(
      'diagnostic: (if ((.stderr // "") | test("spike_[a-z0-9_]+"))',
    );
    expect(workflow).toContain('{"diagnostic":"gateway_unavailable"}');
    expect(workflow).toContain(
      `jq -e 'type == "object"' "$run_response" >/dev/null 2>&1`,
    );
    expect(workflow).not.toContain('VPS_SSH_KEY');
    expect(workflow).toContain('workflow_dispatch:');
  });
  it('can remove only its immutable disposable preview before a clean proof', async () => {
    const workflow = await readFile(
      join(process.cwd(), '.github/workflows/terminal-runtime-spikes.yml'),
      'utf8',
    );
    expect(workflow).toContain(
      "github.event.label.name == 'terminal-preview-reprovision'",
    );
    expect(workflow).toContain(
      'any(.name == "terminal-preview-reprovision")',
    );
    expect(workflow).toContain(
      'if length == 1 then .[0].machineId else error("preview_unavailable") end',
    );
    expect(workflow).toContain(
      '-X DELETE "${PLATFORM_PUBLIC_URL%/}/vps/${machine_id}"',
    );
    expect(workflow).toContain('deadline=$((SECONDS + 300))');
    expect(workflow).not.toContain('VPS_SSH_KEY');
  });
  it('packages the harness only for explicitly marked preview bundles', async () => {
    const [buildScript, previewWorkflow] = await Promise.all([
      readFile(join(process.cwd(), 'scripts/build-host-bundle.sh'), 'utf8'),
      readFile(join(process.cwd(), '.github/workflows/preview-vps.yml'), 'utf8'),
    ]);
    expect(previewWorkflow).toContain("MATRIX_TERMINAL_RUNTIME_SPIKE: '1'");
    expect(previewWorkflow).toContain('Build dormant parent bootstrap bundle');
    expect(buildScript).toContain('if [ "${MATRIX_TERMINAL_RUNTIME_SPIKE:-0}" = "1" ]; then');
    expect(buildScript).toContain('scripts/spikes/terminal-runtime');
  });
  it('requires an exact-head production acceptance matrix beyond S1 and S2', async () => {
    const [workflow, helper, runner, verifier] = await Promise.all([
      readFile(
        join(
          process.cwd(),
          '.github/workflows/terminal-runtime-production-acceptance.yml',
        ),
        'utf8',
      ),
      readFile(
        join(
          process.cwd(),
          'distro/customer-vps/host-bin/matrix-terminal-spike-control',
        ),
        'utf8',
      ),
      readFile(
        join(
          process.cwd(),
          'scripts/spikes/terminal-runtime/production-acceptance.sh',
        ),
        'utf8',
      ),
      readFile(
        join(
          process.cwd(),
          'scripts/spikes/terminal-runtime/verify-production-evidence.mjs',
        ),
        'utf8',
      ),
    ]);
    expect(workflow).toContain("github.event.label.name == 'terminal-production-acceptance'");
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('Build two exact-head acceptance bundles');
    expect(workflow).toContain('mv dist/host-bundle "dist/acceptance-${suffix}"');
    expect(workflow).not.toContain('mv dist/host-bundle/.');
    expect(workflow).not.toContain('dist/acceptance-a/**');
    expect(workflow).toContain('dist/acceptance-a/matrix-host-bundle.tar.gz');
    expect(workflow).toContain('dist/acceptance-a/objects/**');
    expect(workflow).toContain('Wait for exact-head S1/S2 proof');
    expect(workflow).toContain('gh run list --workflow terminal-runtime-spikes.yml');
    expect(workflow).toContain('timeout-minutes: 360');
    expect(runner).toContain('for _ in $(seq 1 4500)');
    expect(workflow).toContain('deadline=$((SECONDS + 18000))');
    expect(workflow).toContain('call_helper acceptance-launch');
    expect(workflow).toContain('call_helper acceptance-reboot');
    expect(workflow).toContain('call_helper acceptance-resume');
    expect(workflow).toContain('call_helper acceptance-pack');
    expect(workflow).toContain('Validate the complete production matrix');
    expect(workflow).not.toMatch(/^\s+env:\n\s+env:/m);
    expect(helper).toContain(
      'acceptance-launch | acceptance-status | acceptance-reboot | acceptance-resume | acceptance-pack',
    );
    expect(helper).toContain('/run/matrix-update-runtime/last-failure-code');
    expect(helper).toContain('spike_control_unavailable_${failure_code}');
    expect(helper).toContain('^[a-z0-9_]{1,64}$');
    for (const check of [
      'bundleOnePreservesRuntime',
      'bundleTwoPreservesRuntime',
      'failedUpdatePreservesRuntime',
      'explicitRollbackPreservesRuntime',
      'rebootStartsNoRuntime',
      'explicitRecoverRestoresRuntime',
      'concurrentRecoverSingleUnit',
      'recoverDeleteCannotResurrect',
      'corruptionFallsBackFresh',
      'deleteWaitsForEmptyCgroup',
    ]) {
      expect(runner).toContain(check);
      expect(verifier).toContain(check);
    }
    expect(runner).toContain(
      "pgrep -a zellij | grep -F -- '--force-run-commands'",
    );
    expect(runner).not.toMatch(
      /zellij(?:_cmd)?\s[^|\n]*--force-run-commands/,
    );
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
    expect(spawnSync(process.execPath, [
      verifier, root, '--expected-head', head,
    ]).status).toBe(0);
    const missing = structuredClone(summary);
    delete missing.checks.bundleTwoPreservesRuntime;
    await writeFile(join(root, 'summary.json'), `${JSON.stringify(missing)}\n`);
    expect(spawnSync(process.execPath, [
      verifier, root, '--expected-head', head,
    ]).status).not.toBe(0);
    await writeFile(join(root, 'summary.json'), `${JSON.stringify({
      ...summary,
      extra: true,
    })}\n`);
    expect(spawnSync(process.execPath, [
      verifier, root, '--expected-head', head,
    ]).status).not.toBe(0);
    await writeFile(join(root, 'summary.json'), `${JSON.stringify(summary)}\n`);
    expect(spawnSync(process.execPath, [
      verifier, root, '--expected-head', 'b'.repeat(40),
    ]).status).not.toBe(0);
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
    expect(workflow).toContain('"launch",');
    expect(workflow).toContain('"pack",');
    expect(workflow).not.toContain('/opt/matrix/app/scripts/spikes');
    expect(workflow).toContain('evidence_deadline=$((SECONDS + 2100))');
    expect(workflow).toContain('"$EVIDENCE" --report-gates');
    expect(workflow).toContain('--unpack "$envelope" "$evidence_parent" "$HEAD_SHA"');
    expect(workflow).not.toContain('tar --extract');
    expect(workflow).not.toContain('REMOTE_STATUS:');
    expect(launcher).toContain('systemd-run');
    expect(launcher).toContain('--collect');
    expect(launcher).toContain('--no-block');
    expect(launcher).toContain('StandardOutput=null');
    expect(launcher).toContain('StandardError=null');
    expect(launcher).toContain('unit="matrix-terminal-runtime-spike-${pr_head_sha}.service"');
    expect(launcher).toContain('summary="/tmp/matrix-terminal-spike-evidence-${pr_head_sha}/summary.json"');
    expect(launcher).not.toContain('short_sha=');
    expect(packer).toContain('summary.json');
    expect(packer).toContain('spike_pack_evidence_incomplete');
    expect(packer).toMatch(/verify-evidence\.mjs \\\n\s+"\$evidence_root" --pack "\$pr_head_sha"/);
    expect(packer).not.toContain('tar --create');
    expect(runner).toContain('run_key="$pr_head_sha"');
    expect(runner).toContain('evidence_root="/tmp/matrix-terminal-spike-evidence-${run_key}"');
    expect(runner).toContain('base_id="1${pr_head_sha:0:31}"');
    expect(runner).toContain("sleep 2\ncleanup\ntrap 'status=$?");
    expect(runner).toContain('curl --fail --silent --max-time 1 http://127.0.0.1:4000/health');
    expect(runner).toContain('zellij delete-session "matrix-t-${runtime_id}" --force');
    expect(runner).toContain('attach-probe.mjs');
    expect(attachProbe).toContain('clientCgroup');
    expect(runner).toContain("value.clientCgroup");
    expect(runner).not.toContain('script -qefc');
    expect(runner).toContain('cgroup_removed');
    expect(runner).not.toContain('install -o matrix -g matrix -m 0600 /dev/null "$runtime_root/confirmations/${recovery_id}.pass"');
    expect(runner).toContain('pkill -f -x');
    expect(runner).toContain('for runtime_id in "${memory_ids[@]}"; do');
    expect(runner).toContain('systemctl set-property --runtime');
    expect(runner).toContain('MemoryHigh=75%');
    expect(runner).toContain('timeout 15s runuser');
    expect(runner).toContain('wait_file');
    const keeper = await readFile(join(process.cwd(), 'scripts/spikes/terminal-runtime/keeper.mjs'), 'utf8');
    expect(keeper).toContain("cgroupRoles(cgroup.path, descriptor.intent === 'create')");
    expect(keeper).toContain("stripVTControlCharacters(renderWindow).includes('<ENTER> run')");
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
