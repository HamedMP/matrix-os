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
    expect(workflow).toContain('needs: [changes, typecheck, patterns, react-doctor, sync-client, unit, e2e]');
    expect(workflow).toContain('### CI Results');
    expect(workflow).toContain('needs.typecheck.result');
    expect(workflow).toContain('needs.patterns.result');
    expect(workflow).toContain('needs.react-doctor.result');
    expect(workflow).toContain('needs.sync-client.result');
    expect(workflow).toContain('needs.unit.result');
    expect(workflow).toContain('needs.e2e.result');
    expect(workflow).toContain('Branch protection should require this aggregate job');
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
    expect(readme).toContain('Screenshot workflow removed');
  });

  it('wires every required Stripe price secret into platform Cloud Run', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    for (const [envName, secretName] of stripePriceSecrets) {
      expect(workflow).toContain(`${envName}=${secretName}:latest`);
      expect(workflow).toContain(`${envName}=${secretName}`);
    }
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

    expect(workflow).toContain('Verify Stripe billing price secrets');
    expect(workflow).toContain('gcloud secrets describe "$secret_name"');
    expect(workflow).toContain('price_secret_tmpfile="$(mktemp)"');
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

  it('smokes the pre-VPS auth and billing shell surface before promotion', () => {
    const root = process.cwd();
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');

    expect(workflow).toContain('Smoke candidate revision');
    expect(workflow).toContain('$CANDIDATE_URL/sign-in');
    expect(workflow).toContain('$CANDIDATE_URL/?billing=setup');
    expect(workflow).toContain('pre-VPS auth shell');
    expect(workflow).toContain('data-matrix-auth-shell="true"');
    expect(workflow).toContain('Loading billing status');
    expect(workflow).toContain('Welcome back to Matrix');
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
});
