import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('CI workflows', () => {
  const stripePriceSecrets = [
    ['STRIPE_PRICE_MATRIX_STARTER_MONTHLY', 'stripe-price-matrix-starter-monthly'],
    ['STRIPE_PRICE_MATRIX_STARTER_ANNUAL', 'stripe-price-matrix-starter-annual'],
    ['STRIPE_PRICE_MATRIX_BUILDER_MONTHLY', 'stripe-price-matrix-builder-monthly'],
    ['STRIPE_PRICE_MATRIX_BUILDER_ANNUAL', 'stripe-price-matrix-builder-annual'],
    ['STRIPE_PRICE_MATRIX_MAX_MONTHLY', 'stripe-price-matrix-max-monthly'],
    ['STRIPE_PRICE_MATRIX_MAX_ANNUAL', 'stripe-price-matrix-max-annual'],
    ['STRIPE_PRICE_EXTRA_RUNTIME_MONTHLY', 'stripe-price-extra-runtime-monthly'],
    ['STRIPE_PRICE_EXTRA_RUNTIME_ANNUAL', 'stripe-price-extra-runtime-annual'],
  ] as const;

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
    expect(readme).toContain('Screenshot workflow removed');
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

  it('requires focused Stripe portal configurations before platform deployment', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('required_billing_secrets=(');
    expect(workflow).toContain('STRIPE_PORTAL_CONFIGURATION_EXTRA_RUNTIME_MONTHLY=stripe-portal-configuration-extra-runtime-monthly');
    expect(workflow).toContain('STRIPE_PORTAL_CONFIGURATION_EXTRA_RUNTIME_ANNUAL=stripe-portal-configuration-extra-runtime-annual');
    expect(workflow).toContain('PORTAL_CONFIGURATION_SECRET_BINDINGS=');
    expect(workflow).not.toContain('Add-computer billing will remain unavailable');
    expect(workflow).toContain(',${PORTAL_CONFIGURATION_SECRET_BINDINGS}"');
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

  it('keeps production platform Cloud Run warm while allowing staging to scale to zero', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('DEPLOY_ENVIRONMENT: ${{ github.event_name == \'workflow_dispatch\' && inputs.environment || \'production\' }}');
    expect(workflow).toContain('min_instances=0');
    expect(workflow).toContain('if [ "$DEPLOY_ENVIRONMENT" = "production" ]; then');
    expect(workflow).toContain('min_instances=1');
    expect(workflow).toContain('--min-instances "$min_instances"');
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

  it('verifies platform Cloud Run promotion sends all traffic to the candidate revision', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('Verify promoted revision traffic');
    expect(workflow).toContain('select(.revisionName == env.CANDIDATE_REVISION) | .percent');
    expect(workflow).toContain('select(.revisionName != env.CANDIDATE_REVISION and (.percent // 0) > 0)');
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

  it('deploys published dev host bundles by exact version on main by default', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/host-bundle-release.yml'), 'utf8');

    expect(workflow).toContain('deploy_after_publish:');
    expect(workflow).toContain('Deploy published host bundle');
    expect(workflow).toContain("github.event_name == 'push' && github.ref_type == 'branch' && github.ref_name == 'main'");
    expect(workflow).toContain('|| inputs.deploy_after_publish');
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
  });
});
