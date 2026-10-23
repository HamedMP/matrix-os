import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const script = 'scripts/ci/platform-ai-credit-release.py';
const subscriptionFlag = 'MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED';
const machineScope = 'MATRIX_FUNDED_AI_ADDON_CHECKOUT_ALLOWED_MACHINE_IDS';
const taxFlag = 'MATRIX_AI_CREDIT_STRIPE_TAX_REGISTRATIONS_VERIFIED';
const controlPlane = 'MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED';
const machine = '00000000-0000-4000-8000-000000000001';
const billingEvents = ['customer.subscription.created', 'customer.subscription.updated',
  'customer.subscription.deleted', 'customer.subscription.trial_will_end',
  'checkout.session.completed', 'checkout.session.expired', 'invoice.paid', 'invoice.payment_failed'];
const paymentEvents = ['checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'charge.refunded', 'charge.dispute.created', 'charge.dispute.closed'];
function run(mode: string, values: Record<string, string> = {}, input = '') {
  return spawnSync('python3', [script, mode], { encoding: 'utf8', input, timeout: 10_000,
    env: { PATH: process.env.PATH, ...values } });
}
function endpoint(events = [...billingEvents, ...paymentEvents]) {
  return JSON.stringify({ status: 'enabled', enabled_events: events });
}

describe('production AI credit deployment configuration', () => {
  it('keeps issuance and tax attestation off by default without adding a preview restriction', () => {
    const result = run('env-bindings');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`|${subscriptionFlag}=false|${taxFlag}=false`);
  });
  it('preserves reviewed subscription, machine scope and tax settings in deploy bindings', () => {
    const result = run('env-bindings', { [subscriptionFlag]: 'true', [machineScope]: JSON.stringify([machine]), [taxFlag]: 'true', [controlPlane]: 'true' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`|${subscriptionFlag}=true|${taxFlag}=true|${machineScope}=["${machine}"]`);
  });
  it.each(['', 'false', 'invalid'])('rejects enabled subscription issuance without its funded ledger dependency (%j)', value => {
    const result = run('env-bindings', { [subscriptionFlag]: 'true', [controlPlane]: value });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });
  it.each(['TRUE', '1', 'true|INJECTED=true', 'true\nINJECTED=true'])('rejects malformed boolean %j before emitting bindings', value => {
    for (const key of [subscriptionFlag, taxFlag]) {
      const result = run('env-bindings', { [key]: value });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
    }
  });
  it.each(['[]', '{}', '["not-a-uuid"]', JSON.stringify(Array(33).fill(machine)), '[', 'x'.repeat(4097)])(
    'rejects invalid or oversized checkout scope without broadening it', value => {
      const result = run('env-bindings', { [machineScope]: value });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
    });
  it('the canonical main deployment carries and validates these settings before authentication', () => {
    const workflow = parse(readFileSync('.github/workflows/platform-cloud-run.yml', 'utf8'));
    const job = workflow.jobs.deploy;
    expect(job.env[subscriptionFlag]).toBe("${{ vars.MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED || 'false' }}");
    expect(job.env[taxFlag]).toBe("${{ vars.MATRIX_AI_CREDIT_STRIPE_TAX_REGISTRATIONS_VERIFIED || 'false' }}");
    expect(job.env[machineScope]).toBe('${{ vars.MATRIX_FUNDED_AI_ADDON_CHECKOUT_ALLOWED_MACHINE_IDS }}');
    const steps = job.steps as Array<{ name?: string; run?: string }>;
    const validate = steps.findIndex(step => step.run?.includes(`${script} validate`));
    expect(validate).toBeGreaterThanOrEqual(0);
    expect(validate).toBeLessThan(steps.findIndex(step => step.name === 'Authenticate to Google Cloud'));
    expect(steps.some(step => step.run?.includes(`${script} env-bindings`))).toBe(true);
    expect(steps.some(step => step.run?.includes(`${script} verify-webhook`))).toBe(true);
    for (const name of ['Verify deployed provisioning contract', 'Verify production provisioning contract']) {
      expect(steps.find(step => step.name === name)?.run).toContain(`${script} verify-revision`);
    }
    expect(workflow.on.push.paths).toContain(script);
  });
  it('checks the actual revision retained configured values before promotion', () => {
    const values = { [subscriptionFlag]: 'true', [taxFlag]: 'true', [machineScope]: JSON.stringify([machine]), [controlPlane]: 'true' };
    const revision = (env: Record<string, string>) => JSON.stringify({ spec: { containers: [{
      env: Object.entries(env).map(([name, value]) => ({ name, value })),
    }] } });
    expect(run('verify-revision', values, revision(values)).status).toBe(0);
    expect(run('verify-revision', values, revision({ ...values, [subscriptionFlag]: 'false' })).status).not.toBe(0);
    expect(run('verify-revision', values, revision({ [subscriptionFlag]: 'true', [taxFlag]: 'true' })).status).not.toBe(0);
    expect(run('verify-revision', {}, revision({ [subscriptionFlag]: 'false', [taxFlag]: 'false', [machineScope]: '["stale"]' })).status).not.toBe(0);
    expect(run('verify-revision', {}, revision({ [subscriptionFlag]: 'false', [taxFlag]: 'false' })).status).toBe(0);
  });
});

describe('canonical Stripe financial event delivery preflight', () => {
  it('accepts the complete enabled endpoint and wildcard event subscription', () => {
    expect(run('verify-webhook', {}, endpoint()).status).toBe(0);
    expect(run('verify-webhook', {}, endpoint(['*'])).status).toBe(0);
  });
  it.each(paymentEvents)('rejects a canonical endpoint missing %s', event => {
    const result = run('verify-webhook', {}, endpoint([...billingEvents, ...paymentEvents.filter(value => value !== event)]));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(event);
  });
  it('preserves the existing required subscription event checks', () => {
    for (const event of billingEvents) {
      expect(run('verify-webhook', {}, endpoint([...billingEvents.filter(value => value !== event), ...paymentEvents])).status).not.toBe(0);
    }
  });
  it.each(['', '{}', 'not-json', endpoint() + '\n' + endpoint(),
    JSON.stringify({ status: 'disabled', enabled_events: ['*'] }),
    JSON.stringify({ status: 'enabled', enabled_events: '*' })])('rejects missing, ambiguous or invalid endpoint metadata', input => {
    expect(run('verify-webhook', {}, input).status).not.toBe(0);
  });
});
