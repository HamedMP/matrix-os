import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

function readChangeDetectionCheckoutRun(root: string): string | undefined {
  const workflow = parse(
    readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'),
  ) as {
    jobs?: {
      changes?: {
        steps?: Array<{
          name?: string;
          run?: string;
        }>;
      };
    };
  };

  return workflow.jobs?.changes?.steps?.find(
    (step) => step.name === 'Checkout with bounded retry',
  )?.run;
}

function runChangeDetectionCheckout(
  checkoutRun: string,
  failuresBeforeSuccess: number,
): {
  attempts: string;
  checkoutCompleted: boolean;
  status: number | null;
  stderr: string;
  stdout: string;
} {
  const tempDir = mkdtempSync(join(tmpdir(), 'matrix-ci-checkout-retry-'));
  const fakeBin = join(tempDir, 'bin');
  const fetchAttempts = join(tempDir, 'fetch-attempts');
  const checkoutMarker = join(tempDir, 'checkout-complete');
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" fetch "* ]]; then
  if [[ " $* " != *" $GITHUB_SHA "* ]]; then
    echo "fetch did not request the event commit" >&2
    exit 64
  fi
  if [[ " $* " == *" --depth=1 "* ]]; then
    echo "event commit fetch must retain full history" >&2
    exit 65
  fi
  attempt=0
  if [ -f "$FAKE_GIT_FETCH_ATTEMPTS" ]; then
    attempt="$(cat "$FAKE_GIT_FETCH_ATTEMPTS")"
  fi
  attempt=$((attempt + 1))
  printf '%s' "$attempt" > "$FAKE_GIT_FETCH_ATTEMPTS"
  if [ "$FAKE_GIT_FAILURES_BEFORE_SUCCESS" -lt 0 ] || [ "$attempt" -le "$FAKE_GIT_FAILURES_BEFORE_SUCCESS" ]; then
    exit 1
  fi
fi
if [[ " $* " == *" checkout --force --detach "* ]]; then
  touch "$FAKE_GIT_CHECKOUT_MARKER"
fi
`,
  );
  chmodSync(join(fakeBin, 'git'), 0o755);

  try {
    const result = spawnSync('bash', ['-c', checkoutRun], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        CHECKOUT_BACKOFF_SECONDS: '0',
        CHECKOUT_MAX_ATTEMPTS: '3',
        CHECKOUT_TIMEOUT_SECONDS: '1',
        FAKE_GIT_CHECKOUT_MARKER: checkoutMarker,
        FAKE_GIT_FAILURES_BEFORE_SUCCESS: String(failuresBeforeSuccess),
        FAKE_GIT_FETCH_ATTEMPTS: fetchAttempts,
        GH_TOKEN: 'test-token',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'HamedMP/matrix-os',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_SHA: '0123456789012345678901234567890123456789',
      },
    });

    return {
      attempts: readFileSync(fetchAttempts, 'utf8'),
      checkoutCompleted: existsSync(checkoutMarker),
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('CI workflows', () => {
  const stripePriceSecrets = [
    ['STRIPE_PRICE_MATRIX_STARTER_MONTHLY', 'stripe-price-matrix-starter-monthly'],
    ['STRIPE_PRICE_MATRIX_STARTER_ANNUAL', 'stripe-price-matrix-starter-annual'],
    ['STRIPE_PRICE_MATRIX_BUILDER_MONTHLY', 'stripe-price-matrix-builder-monthly'],
    ['STRIPE_PRICE_MATRIX_BUILDER_ANNUAL', 'stripe-price-matrix-builder-annual'],
    ['STRIPE_PRICE_MATRIX_MAX_MONTHLY', 'stripe-price-matrix-max-monthly'],
    ['STRIPE_PRICE_MATRIX_MAX_ANNUAL', 'stripe-price-matrix-max-annual'],
  ] as const;

  it('queues main CI runs and delegates only full-plan supersession to a narrow workflow', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const superseder = readFileSync(join(root, '.github/workflows/ci-supersede.yml'), 'utf8');

    expect(workflow).toContain('run-name: CI coverage-v1');
    expect(workflow).toContain('queue: max');
    expect(workflow).not.toContain('cancel-in-progress:');
    expect(superseder).toContain('actions: write');
    expect(superseder).toContain('paths-ignore:');
    expect(superseder).toContain("- 'docs/**'");
    expect(superseder).toContain("- 'specs/**'");
    expect(superseder).toContain("- '**/*.md'");
    expect(superseder).toContain(
      'uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6',
    );
    expect(superseder).toContain(
      'uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6',
    );
    expect(superseder).toContain('node scripts/ci/supersede-main-ci.mjs');
  });

  it('exposes a stable aggregate CI result job for branch protection', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

    expect(workflow).toContain('ci-results:');
    expect(workflow).toContain('name: CI Results');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('needs: [changes, typecheck, shell-production-build, patterns, react-doctor, sync-client, unit, docs-contract, e2e]');
    expect(workflow).toContain('### CI Results');
    expect(workflow).toContain('needs.typecheck.result');
    expect(workflow).toContain('needs.shell-production-build.result');
    expect(workflow).toContain('needs.patterns.result');
    expect(workflow).toContain('needs.react-doctor.result');
    expect(workflow).toContain('needs.sync-client.result');
    expect(workflow).toContain('needs.unit.result');
    expect(workflow).toContain('needs.docs-contract.result');
    expect(workflow).toContain('needs.e2e.result');
    expect(workflow).toContain('"$PATTERNS_RESULT" "$REACT_DOCTOR_RESULT" "$SYNC_CLIENT_RESULT" "$UNIT_RESULT" "$DOCS_CONTRACT_RESULT"');
    expect(workflow).toContain('Branch protection should require this aggregate job');
  });

  it('plans main coverage from the last trusted frontier and wires its range into diff checks', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const changesJob = workflow.slice(
      workflow.indexOf('  changes:'),
      workflow.indexOf('  # ── Gate 1: Mechanical checks'),
    );

    expect(changesJob).toContain('timeout-minutes: 3');
    expect(changesJob).toContain('name: Checkout with bounded retry');
    expect(changesJob).toContain('CHECKOUT_MAX_ATTEMPTS: "3"');
    expect(changesJob).toContain('CHECKOUT_TIMEOUT_SECONDS: "30"');
    expect(changesJob).toContain('CHECKOUT_BACKOFF_SECONDS: "5"');
    expect(changesJob).toContain('timeout --foreground --kill-after=5s');
    expect(changesJob).toContain('for attempt in $(seq 1 "$CHECKOUT_MAX_ATTEMPTS")');
    expect(changesJob).toContain('Checkout fetch failed after $CHECKOUT_MAX_ATTEMPTS attempts');
    expect(changesJob).toContain('git fetch --no-tags --depth=1 origin "$GITHUB_BASE_REF"');
    expect(changesJob).not.toContain('uses: actions/checkout@v6');
    expect(changesJob).not.toContain('fetch-depth: 0');
    expect(changesJob).toContain('node scripts/ci/main-ci-coverage.mjs >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('base_sha: ${{ steps.changed.outputs.base_sha }}');
    expect(workflow).toContain('COVERAGE_BASE_SHA: ${{ needs.changes.outputs.base_sha }}');
    expect(workflow).toContain('COVERAGE_BOOTSTRAP: ${{ needs.changes.outputs.bootstrap }}');
    expect(workflow).toContain('if [ "$COVERAGE_BOOTSTRAP" = "true" ]; then');
    expect(workflow).toContain('BEFORE="$COVERAGE_BASE_SHA"');
  });

  it('recovers when the first change-detection checkout fetch fails transiently', () => {
    const root = process.cwd();
    const checkoutRun = readChangeDetectionCheckoutRun(root);
    expect(checkoutRun).toBeTypeOf('string');

    const result = runChangeDetectionCheckout(checkoutRun ?? 'exit 1', 1);

    expect(result.status, result.stderr).toBe(0);
    expect(result.attempts).toBe('2');
    expect(result.checkoutCompleted).toBe(true);
    expect(result.stdout).toContain('Checkout fetch attempt 1/3');
    expect(result.stdout).toContain('Checkout fetch attempt 2/3');
  });

  it('fails change detection after the bounded checkout attempts are exhausted', () => {
    const root = process.cwd();
    const checkoutRun = readChangeDetectionCheckoutRun(root);
    expect(checkoutRun).toBeTypeOf('string');

    const result = runChangeDetectionCheckout(checkoutRun ?? 'exit 1', -1);

    expect(result.status).toBe(1);
    expect(result.attempts).toBe('3');
    expect(result.checkoutCompleted).toBe(false);
    expect(result.stdout).toContain('Checkout fetch attempt 3/3');
    expect(result.stdout).toContain('Checkout fetch failed after 3 attempts');
  });

  it('runs lightweight docs contract tests for docs-only CI changes', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const readme = readFileSync(join(root, '.github/workflows/README.md'), 'utf8');

    expect(workflow).toContain('docs-contract:');
    expect(workflow).toContain('name: Docs Contract Tests');
    expect(workflow).toContain('docs_contract_tests: ${{ steps.changed.outputs.docs_contract_tests }}');
    expect(workflow).toContain("if: needs.changes.outputs.docs_contract_tests == 'true'");
    expect(workflow).toContain('pnpm exec vitest run tests/repository/site-extraction.test.ts');
    expect(workflow).toContain('| Docs Contract Tests | $DOCS_CONTRACT_RESULT |');
    expect(readme).toContain('- `Docs Contract Tests`');
    expect(readme).toContain('Docs-only changes still run targeted docs contract tests');
  });

  it('builds and requires the MAT-335 Desktop regression in the E2E job', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

    expect(workflow).toContain('name: Build Desktop for Electron E2E');
    expect(workflow).toContain('run: bun run build:desktop');
    expect(workflow).toContain('name: Run required MAT-335 Desktop regression');
    expect(workflow).toContain('MATRIX_DESKTOP_E2E_REQUIRED: "1"');
    expect(workflow).toContain(
      'xvfb-run --auto-servernum bun run test:e2e -- tests/e2e/desktop/project-folder-picker-layout.e2e.test.ts',
    );
  });

  it('documents workflow ownership and required checks', () => {
    const root = process.cwd();
    const readme = readFileSync(join(root, '.github/workflows/README.md'), 'utf8');

    expect(readme).toContain('# GitHub Actions Workflows');
    expect(readme).toContain('CI Results');
    expect(readme).toContain('branch protection');
    expect(readme).toContain('Host Bundle Release');
    expect(readme).toContain('host bundle release tests are blocking');
    expect(readme).toContain('React Doctor');
    expect(readme).toContain('Docs Contract Tests');
    expect(readme).toContain('coverage frontier');
    expect(readme).toContain('ci-supersede.yml');
    expect(readme).toMatch(/Docs-only successors\s+queue behind broader runs/);
    expect(readme).toContain('Screenshot workflow removed');
  });

  it('ships customer runtime bundles without publishing legacy Docker images', () => {
    const root = process.cwd();
    const workflowsDirectory = join(root, '.github/workflows');
    const workflowReadme = readFileSync(join(workflowsDirectory, 'README.md'), 'utf8');
    const releaseDocs = readFileSync(join(root, 'docs/dev/releases.md'), 'utf8');
    const datedUpgradeGuide = readFileSync(
      join(root, 'docs/dev/upgrade-2026-04-02.md'),
      'utf8',
    );
    const contributorGuide = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');
    const orchestrator = readFileSync(join(root, 'packages/platform/src/orchestrator.ts'), 'utf8');
    const platformCompose = readFileSync(join(root, 'distro/docker-compose.platform.yml'), 'utf8');
    const deployStatusCommand = readFileSync(
      join(root, '.claude/commands/deploy-status.md'),
      'utf8',
    );
    const releaseCommand = readFileSync(join(root, '.claude/commands/release.md'), 'utf8');
    const shipCommand = readFileSync(join(root, '.claude/commands/ship.md'), 'utf8');
    const workflowSources = readdirSync(workflowsDirectory)
      .filter((fileName) => fileName.endsWith('.yml') || fileName.endsWith('.yaml'))
      .map((fileName) => readFileSync(join(workflowsDirectory, fileName), 'utf8'));

    expect(existsSync(join(workflowsDirectory, 'docker.yml'))).toBe(false);
    expect(existsSync(join(workflowsDirectory, 'host-bundle-release.yml'))).toBe(true);
    expect(workflowReadme).toContain('Matrix OS does not publish customer runtime Docker images');
    expect(workflowReadme).toContain('Docker remains supported for local development and CI validation only');
    expect(workflowReadme).not.toContain('| `docker.yml`');
    expect(releaseDocs).toContain('## Release Artifact Inventory');
    expect(releaseDocs).toContain('VPS host bundle');
    expect(releaseDocs).toContain('Platform service image');
    expect(releaseDocs).toContain('Mobile native builds');
    expect(releaseDocs).toContain('Mobile OTA update');
    expect(releaseDocs).toContain('Desktop installers and OTA metadata');
    expect(releaseDocs).toContain('`@finnaai/matrix` CLI');
    expect(datedUpgradeGuide).toContain('procedure is retired');
    expect(datedUpgradeGuide).toContain('[Release Process](releases.md)');
    expect(orchestrator).toContain("image = 'matrixos-user:local'");
    expect(platformCompose).toContain(
      'PLATFORM_IMAGE=${PLATFORM_IMAGE:-matrixos-user:local}',
    );
    expect(platformCompose).toContain('image: matrixos-user:local');
    expect(platformCompose).not.toContain(
      'image: ${PLATFORM_IMAGE:-matrixos-user:local}',
    );
    expect(contributorGuide).toContain('| Host bundle | `host-bundle-release.yml`');
    expect(contributorGuide).toContain('| Platform | `platform-cloud-run.yml`');
    expect(contributorGuide).toContain('Customer releases are VPS-native host bundles');
    expect(deployStatusCommand).toContain('host-bundle-release.yml');
    expect(deployStatusCommand).toContain('platform-cloud-run.yml');
    expect(releaseCommand).toContain('host-bundle-release.yml');
    expect(shipCommand).toContain('host-bundle-release.yml');

    for (const activeSource of [
      contributorGuide,
      datedUpgradeGuide,
      orchestrator,
      platformCompose,
      deployStatusCommand,
      releaseCommand,
      shipCommand,
    ]) {
      expect(activeSource).not.toContain('ghcr.io/hamedmp/matrix-os');
      expect(activeSource).not.toContain('docker.yml');
    }

    for (const workflow of workflowSources) {
      expect(workflow).not.toContain('ghcr.io/hamedmp/matrix-os');
      expect(workflow).not.toMatch(/packages:\s*write/);
    }
  });

  it('reuses one Docker test image artifact across scenario jobs', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/docker-test.yml'), 'utf8');

    expect(workflow).toContain('name: Upload Docker image artifact');
    expect(workflow).toContain('name: Download Docker image artifact');
    expect(workflow).toContain('uses: actions/download-artifact@v7');
    expect(workflow).not.toContain('uses: actions/download-artifact@v8');
    expect(workflow).toContain('outputs: type=docker,dest=/tmp/matrix-os-dev-ci.tar');
    expect(workflow).toContain('gzip -1 < /tmp/matrix-os-dev-ci.tar > /tmp/matrix-os-dev-ci.tar.gz');
    expect(workflow).toContain('rm /tmp/matrix-os-dev-ci.tar');
    expect(workflow).toContain('test "$(stat -c%s /tmp/matrix-os-dev-ci.tar.gz)" -gt 1000000');
    expect(workflow).toContain('gzip -t /tmp/matrix-os-dev-ci.tar.gz');
    expect(workflow).toContain('gzip -t /tmp/docker-image/matrix-os-dev-ci.tar.gz');
    expect(workflow).toContain('gzip -dc /tmp/docker-image/matrix-os-dev-ci.tar.gz | docker load');
    expect(workflow).not.toContain('docker save matrix-os-dev:ci | gzip -1');

    const dockerBuildActionUses = workflow.match(/uses: docker\/build-push-action@v7/g) ?? [];
    expect(dockerBuildActionUses).toHaveLength(1);
  });

  it('keeps Docker push checks green while reserving smoke execution for pull requests', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/docker-test.yml'), 'utf8');
    const smokeHeader = workflow.match(/docker-smoke:[\s\S]*?steps:/)?.[0] ?? '';

    expect(workflow).toContain('name: Docker Smoke Test');
    expect(smokeHeader).toContain("if: needs.changes.outputs.should_run == 'true'");
    expect(smokeHeader).not.toContain("if: needs.changes.outputs.should_run == 'true' && github.event_name == 'pull_request'");
    expect(workflow).toContain('name: Record push coverage');
    expect(workflow).toContain('Full Docker scenario matrix covers push runs; PR smoke runs only on pull_request events.');
  });

  it('routes PR and main Docker checks through the tested relevance classifier', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/docker-test.yml'), 'utf8');
    const readme = readFileSync(join(root, '.github/workflows/README.md'), 'utf8');

    expect(workflow).toContain('node scripts/ci/docker-relevance.mjs');
    expect(workflow).toContain('--base "origin/$GITHUB_BASE_REF"');
    expect(workflow).toContain('--head "$GITHUB_SHA"');
    expect(workflow).toContain('--commit "$GITHUB_SHA"');
    expect(workflow).toContain('--format github >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('[ "$GITHUB_EVENT_NAME" = "merge_group" ]');
    expect(workflow).toContain('[ "$GITHUB_EVENT_NAME" = "schedule" ]');
    expect(workflow).toContain('[ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ]');
    expect(workflow).not.toContain('case "$file" in');
    expect(readme).toContain('scripts/ci/docker-relevance.mjs');
    expect(readme).toMatch(/merge\s+queue, nightly, and manual runs remain comprehensive/);
  });

  it('gives Docker scenario jobs enough timeout for slow artifact transfer before tests start', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/docker-test.yml'), 'utf8');
    const scenariosHeader = workflow.match(/docker-scenarios:[\s\S]*?strategy:/)?.[0] ?? '';

    expect(workflow).toContain('docker-scenarios:');
    expect(scenariosHeader).toContain('timeout-minutes: 45');
    expect(scenariosHeader).not.toContain('timeout-minutes: 20');
  });

  it('retries Docker compose image pulls before scenario startup', () => {
    const root = process.cwd();
    const harness = readFileSync(join(root, 'scripts/docker-test/lib.sh'), 'utf8');
    const scenarioScripts = [
      'fresh-install.sh',
      'upgrade.sh',
      'customized-files.sh',
      'channels.sh',
      'recovery.sh',
    ];

    expect(harness).toContain('pull_compose_images()');
    expect(harness).toContain('DOCKER_PULL_ATTEMPTS');
    expect(harness).toContain('docker compose');
    expect(harness).toContain('pull --quiet --ignore-buildable');

    for (const scriptName of scenarioScripts) {
      const scenario = readFileSync(join(root, 'scripts/docker-test', scriptName), 'utf8');
      const firstStartup = scenario.indexOf('$COMPOSE up $COMPOSE_UP_FLAGS -d dev');

      expect(firstStartup).toBeGreaterThan(0);
      expect(scenario.slice(0, firstStartup)).toContain('pull_compose_images');
    }
  });

  it('runs sync-client CI only on the supported Node 20 runtime', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const readme = readFileSync(join(root, '.github/workflows/README.md'), 'utf8');

    expect(workflow).toContain('name: Sync Client Package');
    expect(workflow).toContain('node-version: 20');
    expect(workflow).not.toContain('matrix:\n        node: [20, 24]');
    expect(workflow).not.toContain('Sync Client Package (Node 20/24)');
    expect(readme).toContain('Sync Client Package (Node 20)');
    expect(readme).not.toContain('Sync Client Package (Node 20/24)');
  });

  it('uses Node 20 for the dedicated installable CLI release jobs', () => {
    const root = process.cwd();
    const cliReleaseWorkflow = readFileSync(join(root, '.github/workflows/cli-release.yml'), 'utf8');

    const setupNodeBlocks = cliReleaseWorkflow.match(/uses: actions\/setup-node@v6[\s\S]*?node-version: \d+/g) ?? [];
    expect(setupNodeBlocks.length).toBeGreaterThan(0);
    expect(setupNodeBlocks.every((block) => block.includes('node-version: 20'))).toBe(true);
  });

  it('publishes the installable CLI from cli-v tags without requiring manual inputs', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/cli-release.yml'), 'utf8');

    expect(workflow).toContain("group: cli-release-${{ github.ref_type == 'tag' && github.ref_name || format('cli-v{0}', inputs.version) }}");
    expect(workflow).not.toContain("group: cli-release-${{ github.ref_type == 'tag' && github.ref_name || inputs.version }}");
    expect(workflow).toContain('tags:\n      - "cli-v*"');
    expect(workflow).toContain('if [ "$GITHUB_REF_TYPE" = "tag" ]; then');
    expect(workflow).toContain('VERSION="${GITHUB_REF_NAME#cli-v}"');
    expect(workflow).toContain("if: ${{ github.event_name == 'push' || inputs.update_homebrew }}");
    expect(workflow).toContain('if [ "$GITHUB_REF_TYPE" != "tag" ] && git ls-remote --exit-code --tags origin "refs/tags/cli-v${VERSION}"');
  });

  it('uses compatible artifact actions in CLI release workflows', () => {
    const root = process.cwd();
    const cliReleaseWorkflow = readFileSync(join(root, '.github/workflows/cli-release.yml'), 'utf8');
    const releaseWorkflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');

    for (const workflow of [cliReleaseWorkflow, releaseWorkflow]) {
      expect(workflow).toContain('uses: actions/upload-artifact@v7');
      expect(workflow).toContain('uses: actions/download-artifact@v7');
      expect(workflow).not.toContain('uses: actions/upload-artifact@v4');
      expect(workflow).not.toContain('uses: actions/download-artifact@v8');
    }
  });

  it('builds standalone CLI assets before publishing npm in the manual release workflow', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');

    expect(workflow).toContain('publish-npm:\n    name: Publish npm\n    needs: [test, build-macos, build-binaries]');
    expect(workflow).toContain('build-binaries:\n    name: Build standalone binaries\n    needs: test');
    expect(workflow).not.toContain('build-binaries:\n    name: Build standalone binaries\n    needs: publish-npm');
  });

  it('wires every required Stripe price secret into platform Cloud Run', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    for (const [envName, secretName] of stripePriceSecrets) {
      expect(workflow).toContain(`${envName}=${secretName}:latest`);
      expect(workflow).toContain(`${envName}=${secretName}`);
    }
  });

  it('deploys the card-trial rollout flag and verifies every trial lifecycle webhook', () => {
    const root = process.cwd();
    const production = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');
    const preview = readFileSync(join(root, '.github/workflows/preview-platform.yml'), 'utf8');

    expect(production).toContain("MATRIX_CARD_TRIALS_ENABLED: ${{ vars.MATRIX_CARD_TRIALS_ENABLED || 'true' }}");
    expect(production).toContain('MATRIX_CARD_TRIALS_ENABLED=${MATRIX_CARD_TRIALS_ENABLED}');
    expect(production).toContain("MATRIX_CARD_TRIAL_DAYS: ${{ vars.MATRIX_CARD_TRIAL_DAYS || '3' }}");
    expect(production).toContain('MATRIX_CARD_TRIAL_DAYS=${MATRIX_CARD_TRIAL_DAYS}');
    expect(production).toContain('MATRIX_CARD_TRIAL_DAYS must be an integer from 1 to 30.');
    expect(production).toContain('[[ "$MATRIX_CARD_TRIAL_DAYS" =~ ^(0*[1-9]|0*[12][0-9]|0*30)$ ]]');
    expect(production).not.toContain('10#$MATRIX_CARD_TRIAL_DAYS');
    expect(preview).toContain("MATRIX_CARD_TRIALS_ENABLED: ${{ vars.MATRIX_CARD_TRIALS_ENABLED || 'true' }}");
    expect(preview).toContain('MATRIX_CARD_TRIALS_ENABLED=${MATRIX_CARD_TRIALS_ENABLED}');
    expect(preview).toContain("MATRIX_CARD_TRIAL_DAYS: ${{ vars.MATRIX_CARD_TRIAL_DAYS || '3' }}");
    expect(preview).toContain('MATRIX_CARD_TRIAL_DAYS=${MATRIX_CARD_TRIAL_DAYS}');
    expect(preview).toContain('MATRIX_CARD_TRIAL_DAYS must be an integer from 1 to 30.');
    expect(preview).toContain('[[ "$MATRIX_CARD_TRIAL_DAYS" =~ ^(0*[1-9]|0*[12][0-9]|0*30)$ ]]');
    expect(preview).not.toContain('10#$MATRIX_CARD_TRIAL_DAYS');
    expect(preview).toContain('MATRIX_CARD_TRIALS_ENABLED must be true or false.');
    for (const eventType of [
      'customer.subscription.trial_will_end',
      'invoice.paid',
      'invoice.payment_failed',
    ]) {
      expect(production).toContain(eventType);
    }
  });

  it('durably deploys fail-closed prebilling for every new primary signup', () => {
    const root = process.cwd();
    const production = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(production).toContain("MATRIX_PREBILLING_PROVISIONING_ENABLED: 'true'");
    expect(production).toContain("MATRIX_PREBILLING_PROVISIONING_ROLLOUT_PERCENT: '100'");
    expect(production).toContain("MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE: ${{ vars.MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE || '1' }}");
    expect(production).toContain("MATRIX_PREBILLING_PROVISIONING_MAX_HOURLY_COST_MICROS: ${{ vars.MATRIX_PREBILLING_PROVISIONING_MAX_HOURLY_COST_MICROS || '254000' }}");
    expect(production).toContain("MATRIX_PREBILLING_PROVISIONING_COSTS: ${{ vars.MATRIX_PREBILLING_PROVISIONING_COSTS || 'cpx22:92900;cpx32:169900;cpx52:254000' }}");
    for (const name of [
      'MATRIX_PREBILLING_PROVISIONING_ENABLED',
      'MATRIX_PREBILLING_PROVISIONING_ROLLOUT_PERCENT',
      'MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE',
      'MATRIX_PREBILLING_PROVISIONING_MAX_HOURLY_COST_MICROS',
      'MATRIX_PREBILLING_PROVISIONING_COSTS',
    ]) {
      expect(production).toContain(`${name}=\${${name}}`);
    }
    expect(production).toContain('Verify deployed prebilling contract');
    expect(production).toContain('prebilling deployment contract is missing');
  });

  it('preflights and binds distinct golden snapshot operator secrets for platform revisions', () => {
    const root = process.cwd();
    const production = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');
    const preview = readFileSync(join(root, '.github/workflows/preview-platform.yml'), 'utf8');

    expect(production).toContain('Verify golden snapshot operator secret');
    expect(production).toContain('GOLDEN_SNAPSHOT_OPERATOR_SECRET=golden-snapshot-operator-secret:latest');
    expect(production).toContain('gcloud secrets versions access latest --secret "$snapshot_operator_secret_name"');
    expect(production).toContain('roles/secretmanager.secretAccessor');

    expect(preview).toContain('Verify preview golden snapshot operator secret');
    expect(preview).toContain('GOLDEN_SNAPSHOT_OPERATOR_SECRET=golden-snapshot-operator-secret-preview:latest');
    expect(preview).toContain('gcloud secrets versions access latest --secret "$snapshot_operator_secret_name"');
    expect(preview).toContain('roles/secretmanager.secretAccessor');
  });

  it('does not require add-on prices or focused portal configurations for platform deployment', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('required_billing_secrets=(');
    expect(workflow).not.toContain('STRIPE_PRICE_EXTRA_RUNTIME');
    expect(workflow).not.toContain('STRIPE_PORTAL_CONFIGURATION_EXTRA_RUNTIME');
    expect(workflow).not.toContain('PORTAL_CONFIGURATION_SECRET_BINDINGS');
  });

  it('wires Pipedream integration secrets into platform Cloud Run', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('Verify Pipedream integration secrets');
    expect(workflow).toContain('PIPEDREAM_CLIENT_ID=pipedream-client-id:latest');
    expect(workflow).toContain('PIPEDREAM_CLIENT_SECRET=pipedream-client-secret:latest');
    expect(workflow).toContain('PIPEDREAM_PROJECT_ID=pipedream-project-id:latest');
    expect(workflow).toContain('PIPEDREAM_ENVIRONMENT=pipedream-environment:latest');
    expect(workflow).not.toContain('PIPEDREAM_WEBHOOK_SECRET=pipedream-webhook-secret:latest');
    expect(workflow).toContain('required_pipedream_secrets=(');
    expect(workflow).toContain('pipedream_secret_tmpfile="$(mktemp)"');
  });

  it('preflights, mounts, and smokes the dedicated recruiting ATS dependencies', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('ATS_BOOKING_BASE_URL: ${{ vars.ATS_BOOKING_BASE_URL }}');
    expect(workflow).toContain('ATS_BOOKING_BASE_URL=${ATS_BOOKING_BASE_URL}');
    expect(workflow).toContain('Verify recruiting ATS secrets');
    expect(workflow).toContain('ATS_DATABASE_URL=ats-database-url');
    expect(workflow).toContain('ATS_INGEST_SECRET=ats-ingest-secret');
    expect(workflow).toContain('ATS_ADMIN_SECRET=ats-admin-secret');
    expect(workflow).toContain('ATS_DATABASE_URL=ats-database-url:latest');
    expect(workflow).toContain('ATS_INGEST_SECRET=ats-ingest-secret:latest');
    expect(workflow).toContain('ATS_ADMIN_SECRET=ats-admin-secret:latest');
    expect(workflow).toContain('ats_secret_tmpfile="$(mktemp)"');
    expect(workflow).toContain('ATS ingest smoke');
    expect(workflow).toContain('/api/ats/applications');
    expect(workflow).toContain(".error == \"Invalid application\" and keys == [\"error\"]");
    expect(workflow).toContain('ATS admin database smoke');
    expect(workflow).toContain('/api/ats/admin/applications');
  });

  it('preflights billing price secrets before deploying platform Cloud Run', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('Verify Stripe billing secrets');
    expect(workflow).toContain('gcloud secrets describe "$secret_name"');
    expect(workflow).toContain('billing_secret_tmpfile="$(mktemp)"');
    expect(workflow).toContain('gcloud secrets versions access latest --secret "$secret_name"');
    expect(workflow).toContain('roles/secretmanager.secretAccessor');
    expect(workflow).toContain('CLOUD_RUN_SERVICE_ACCOUNT');
  });

  it('preflights the Stripe webhook lifecycle contract before production deployment', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('Verify Stripe webhook lifecycle events');
    expect(workflow).toContain('checkout.session.completed');
    expect(workflow).toContain('checkout.session.expired');
    expect(workflow).toContain('/billing/webhooks/stripe');
    expect(workflow).toContain('https://api.stripe.com/v1/webhook_endpoints');
    expect(workflow).toContain('stripe-secret-key');
    expect(workflow).toContain('has_more');
    expect(workflow).toContain('starting_after');
  });

  it('keeps production platform Cloud Run warm while allowing staging to scale to zero', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('DEPLOY_ENVIRONMENT: ${{ github.event_name == \'workflow_dispatch\' && inputs.environment || \'production\' }}');
    expect(workflow).toContain('min_instances=0');
    expect(workflow).toContain('if [ "$DEPLOY_ENVIRONMENT" = "production" ]; then');
    expect(workflow).toContain('min_instances=1');
    expect(workflow).toContain('--min-instances "$min_instances"');
  });

  it('allocates CPU outside requests for production background workers', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');
    const productionRoleDeploy = workflow.match(
      /- name: Deploy production-role revision[\s\S]*?- name: Promote revision/,
    )?.[0] ?? '';

    expect(productionRoleDeploy).toContain('PLATFORM_BACKGROUND_WORKERS_ENABLED=true');
    expect(productionRoleDeploy).toContain('--no-cpu-throttling');
  });

  it('smokes the pre-VPS auth and onboarding shell surface before promotion', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('Smoke candidate revision');
    expect(workflow).toContain('$CANDIDATE_URL/sign-in');
    expect(workflow).toContain('$CANDIDATE_URL/?billing=setup');
    expect(workflow).toContain('pre-VPS auth shell');
    expect(workflow).toContain('data-matrix-auth-shell="true"');
    expect(workflow).toContain('data-matrix-(billing-gate|boot-sequence)="true"');
    expect(workflow).toContain('did not serve the billing gate or boot sequence');
    expect(workflow).toContain('data-matrix-platform-fallback-auth="true"');
    expect(workflow).toContain('served the platform fallback auth page');
  });

  it('smokes /sign-in through trusted edge-router headers instead of the raw candidate host', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('--secret edge-router-secret');
    expect(workflow).toContain('echo "::add-mask::$edge_router_secret"');
    expect(workflow).toContain('--header "x-forwarded-host: ${app_domain_host}"');
    expect(workflow).toContain('--header "x-matrix-edge-secret: ${edge_router_secret}"');
    expect(workflow).not.toContain('--max-time 10 "$CANDIDATE_URL/sign-in"');
  });

  it('builds browser PostHog clients against the same-origin relay and UI host', () => {
    const root = process.cwd();
    const browserBuildWorkflows = [
      readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'),
      readFileSync(join(root, '.github/workflows/preview-vps.yml'), 'utf8'),
      readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8'),
    ];
    const platformWorkflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    for (const workflow of browserBuildWorkflows) {
      expect(workflow).toMatch(/NEXT_PUBLIC_POSTHOG_API_HOST:[^\n]*['"]?\/relay['"]?/);
      expect(workflow).toMatch(/NEXT_PUBLIC_POSTHOG_HOST:[^\n]*https:\/\/eu\.posthog\.com/);
      expect(workflow).not.toMatch(/NEXT_PUBLIC_POSTHOG_(?:HOST|API_HOST):[^\n]*https:\/\/eu\.i\.posthog\.com/);
    }

    expect(platformWorkflow).toContain("POSTHOG_PUBLIC_HOST: ${{ vars.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.posthog.com' }}");
    expect(platformWorkflow).toContain("POSTHOG_PUBLIC_API_HOST: ${{ vars.NEXT_PUBLIC_POSTHOG_API_HOST || '/relay' }}");
    expect(platformWorkflow).toContain('_NEXT_PUBLIC_POSTHOG_HOST=$POSTHOG_PUBLIC_HOST');
    expect(platformWorkflow).toContain('_NEXT_PUBLIC_POSTHOG_API_HOST=$POSTHOG_PUBLIC_API_HOST');
  });

  it('redeploys the platform when the Cloud Run workflow itself changes', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('- ".github/workflows/platform-cloud-run.yml"');
  });

  it('verifies platform Cloud Run promotion sends all traffic to the production-role revision', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('Verify promoted revision traffic');
    expect(workflow).toContain('select(.revisionName == env.PRODUCTION_REVISION) | .percent');
    expect(workflow).toContain('select(.revisionName != env.PRODUCTION_REVISION and (.percent // 0) > 0)');
    expect(workflow).toContain('--image "$IMAGE_DIGEST"');
  });

  it('uses a registry-backed BuildKit cache for platform Cloud Build', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');
    const cloudbuild = readFileSync(join(root, 'cloudbuild.platform.yaml'), 'utf8');

    expect(workflow).toContain('CACHE_IMAGE=$cache_image');
    expect(workflow).toContain('matrix-platform:buildcache');
    expect(workflow).toContain('_CACHE_IMAGE=$cache_image');

    expect(cloudbuild).toContain('_CACHE_IMAGE:');
    expect(cloudbuild).toContain('DOCKER_BUILDKIT=1');
    expect(cloudbuild).toContain('BUILDKIT_INLINE_CACHE=1');
    expect(cloudbuild).toContain('--cache-from');
    expect(cloudbuild).toContain('${_CACHE_IMAGE}');
    expect(cloudbuild).toContain('- ${_CACHE_IMAGE}');
  });

  it('writes platform build evidence to the workflow summary before promotion', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('### Platform Cloud Run build');
    expect(workflow).toContain('- source_sha:');
    expect(workflow).toContain('${GITHUB_SHA}');
    expect(workflow).toContain('- lane:');
    expect(workflow).toContain('platform');
    expect(workflow).toContain('- image:');
    expect(workflow).toContain('${image}');
    expect(workflow).toContain('- build_id:');
    expect(workflow).toContain('${build_id}');
    expect(workflow).toContain('- cache_image:');
    expect(workflow).toContain('${cache_image}');
  });

  it('publishes main dev host bundles without deploying the fleet', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');
    const releaseDocs = readFileSync(join(root, 'docs/dev/releases.md'), 'utf8');
    const deployJob = workflow.slice(workflow.indexOf('\n  deploy:'));

    expect(workflow).toContain('deploy_after_publish:');
    expect(workflow).toMatch(/deploy_after_publish:[\s\S]*?default: false/);
    expect(workflow).toContain('Deploy published host bundle');
    expect(deployJob).toContain("github.event_name == 'workflow_dispatch' && inputs.deploy_after_publish");
    expect(deployJob).toContain("(github.ref_type == 'branch' && github.ref_name == 'main') || github.ref_type == 'tag'");
    expect(deployJob).not.toContain("github.event_name == 'push'");
    expect(workflow).not.toContain("|| inputs.severity == 'security'");
    expect(workflow).toContain('PUBLISH_VERSION: ${{ needs.build.outputs.version }}');
    expect(workflow).toContain('VERSION="$PUBLISH_VERSION"');
    expect(workflow).not.toContain('VERSION="${{ needs.build.outputs.version }}"');
    expect(workflow).toContain('DEPLOY_RESPONSE="$(curl --fail --silent --show-error --max-time 30 \\');
    expect(workflow).toContain('failed="$(printf \'%s\' "$DEPLOY_RESPONSE" | jq -r \'.failed // 0\')"');
    expect(workflow).toContain('triggered="$(printf \'%s\' "$DEPLOY_RESPONSE" | jq -r \'.triggered // 0\')"');
    expect(workflow).toContain('if [ "$failed" -gt 0 ] || [ "$triggered" -eq 0 ]; then');
    expect(workflow).toContain('-d "{\\"version\\":\\"$VERSION\\"}"');
    expect(workflow).not.toContain('Auto-deploy on security severity');
    expect(releaseDocs).toContain('`deploy_after_publish=true`');
    expect(releaseDocs).toContain('Security severity does not override this opt-in deployment gate.');
    expect(releaseDocs).not.toContain('which auto-deploys the built version after publish');
  });
});
