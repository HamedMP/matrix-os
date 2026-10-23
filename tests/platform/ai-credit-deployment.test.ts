import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

{
const workflow = parse(readFileSync(".github/workflows/platform-cloud-run.yml", "utf8"));
const steps = workflow.jobs.deploy.steps as { name: string; run?: string }[];
const step = (name: string) => steps.find((entry) => entry.name === name)!.run!;
const creditReleaseDefaults = {
  MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED: 'false',
  MATRIX_AI_CREDIT_STRIPE_TAX_REGISTRATIONS_VERIFIED: 'false',
  MATRIX_FUNDED_AI_ADDON_CHECKOUT_ALLOWED_MACHINE_IDS: '',
};
const env = {
  PATH: process.env.PATH,
  GCP_PROJECT_ID: "fixture", GCP_REGION: "europe-west3", ARTIFACT_REPOSITORY: "fixture",
  CLOUD_RUN_SERVICE: "fixture", CLOUD_RUN_SERVICE_ACCOUNT: "fixture",
  PLATFORM_PUBLIC_URL: "https://app.example.com", MATRIX_API_ORIGIN: "https://api.example.com",
  MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "fixture",
  MATRIX_COLLABORATION_ALLOWED_ORIGINS: "https://app.example.com",
  MATRIX_APP_URL: "https://app.example.com", MATRIX_APP_DOMAIN_HOSTS: "app.example.com",
  MATRIX_CODE_DOMAIN_HOSTS: "code.example.com", DEPLOY_ENVIRONMENT: "staging",
  GOLDEN_SNAPSHOT_BUILDS_ENABLED: "false", MATRIX_CARD_TRIALS_ENABLED: "true",
  MATRIX_CARD_TRIAL_DAYS: "3", MATRIX_STARTER_TRIAL_DAYS: "14", MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE: "4",
  CUSTOM_MCP_ENABLED: "false", MCP_CREDENTIAL_ENCRYPTION_KEY_VERSION: "1",
  PLATFORM_SPEECH_ENABLED: "false", MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED: "false",
  MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "false", MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false",
  MATRIX_FUNDED_HOST_CONFIG_ENABLED: "false",
  MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: "false", MATRIX_FUNDED_AI_RELAY_URL: "",
  MATRIX_FUNDED_AI_MODEL_PROBE_DAILY_LIMIT: "10", MATRIX_FUNDED_AI_MODEL_PROBE_MINUTE_LIMIT: "1",
  STRIPE_PRICE_AI_CREDIT_USD_5: "", STRIPE_PRICE_AI_CREDIT_USD_10: "",
  STRIPE_PRICE_AI_CREDIT_USD_25: "",
};

function validate(overrides: Record<string, string>) {
  return spawnSync("bash", ["-c", step("Validate deployment configuration")], {
    encoding: "utf8", env: { ...env, ...overrides },
  });
}

describe("Matrix AI credit Cloud Run deployment", () => {
  it("keeps checkout disabled without funded AI or price configuration", () => {
    expect(validate({}).status).toBe(0);
    expect(workflow.jobs.deploy.env.MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED)
      .toContain("vars.MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED");
  });

  it("requires a funded route and three distinct Stripe prices before checkout can be enabled", () => {
    const enabled = {
      MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: "true",
      MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "true",
      MATRIX_FUNDED_AI_RUNTIME_ENABLED: "true",
      MATRIX_FUNDED_AI_RELAY_URL: "https://relay.example.com",
      STRIPE_PRICE_AI_CREDIT_USD_5: "price_credit5",
      STRIPE_PRICE_AI_CREDIT_USD_10: "price_credit10",
      STRIPE_PRICE_AI_CREDIT_USD_25: "price_credit25",
    };
    expect(validate(enabled).status).toBe(0);
    expect(validate({ ...enabled, MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false" }).status).not.toBe(0);
    expect(validate({ ...enabled, STRIPE_PRICE_AI_CREDIT_USD_10: "" }).status).not.toBe(0);
    expect(validate({ ...enabled, STRIPE_PRICE_AI_CREDIT_USD_10: "price_credit5" }).status).not.toBe(0);
    expect(validate({ ...enabled, MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: "typo" }).status).not.toBe(0);
  });

  it("binds the reviewed package IDs only when checkout is enabled", () => {
    const script = step("Deploy tagged revision").split("candidate_url=")[0];
    const deploy = (overrides: Record<string, string>) => spawnSync("bash", ["-c", `
      gcloud() { if [ "$2 $3" = "services describe" ]; then return 1; fi; printf '%s\\n' "$@"; }
      ${script}
      printf '%s\\n' "$deploy_json"
    `], { encoding: "utf8", env: { ...env, ...Object.fromEntries(
      Object.keys(workflow.jobs.deploy.env).map((key) => [key, "fixture"])),
      ...creditReleaseDefaults,
      MATRIX_CARD_TRIAL_DAYS: "3", MATRIX_STARTER_TRIAL_DAYS: "14",
      GOOGLE_TAG_MANAGER_ID: "GTM-TEST123", GOOGLE_ANALYTICS_MEASUREMENT_ID: "",
      GOOGLE_ANALYTICS_API_SECRET_VERSION: "1",
      WHATSAPP_ENABLED: "false", WHATSAPP_ENCRYPTION_KEY_VERSION: "1",
      ACCOUNT_DELETION_CONFIGURED: "false", ACCOUNT_DELETION_ENABLED: "false",
      IMAGE_DIGEST: "image@sha256:fixture", ...overrides } });
    const disabled = deploy({ MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "false",
      MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false", MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: "false" });
    expect(disabled.status, disabled.stderr).toBe(0);
    expect(disabled.stdout).toContain("MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED=false");
    expect(disabled.stdout).not.toContain("STRIPE_PRICE_AI_CREDIT_USD_5=");

    const enabled = deploy({ MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "true",
      MATRIX_FUNDED_AI_RUNTIME_ENABLED: "true", MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: "true",
      STRIPE_PRICE_AI_CREDIT_USD_5: "price_credit5",
      STRIPE_PRICE_AI_CREDIT_USD_10: "price_credit10",
      STRIPE_PRICE_AI_CREDIT_USD_25: "price_credit25" });
    expect(enabled.status, enabled.stderr).toBe(0);
    expect(enabled.stdout).toContain("MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED=true");
    expect(enabled.stdout).toContain("STRIPE_PRICE_AI_CREDIT_USD_5=price_credit5");
    expect(enabled.stdout).toContain("STRIPE_PRICE_AI_CREDIT_USD_10=price_credit10");
    expect(enabled.stdout).toContain("STRIPE_PRICE_AI_CREDIT_USD_25=price_credit25");
  });
});


describe("Matrix AI route-probe deployment wiring", () => {
  const enabled = { MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "true", MATRIX_FUNDED_AI_RUNTIME_ENABLED: "true",
    MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: "false", MATRIX_FUNDED_AI_RELAY_URL: "https://relay.example.com",
    MATRIX_FUNDED_AI_MODEL_PROBE_DAILY_LIMIT: "10", MATRIX_FUNDED_AI_MODEL_PROBE_MINUTE_LIMIT: "1" };

  it("allows production control-plane canary acceptance while new-runtime provisioning stays disabled", () => {
    const result = validate({ ...enabled, DEPLOY_ENVIRONMENT: "production", ATS_BOOKING_BASE_URL: "https://booking.example.com",
      MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("requires the control plane before funded runtime provisioning can be enabled", () => {
    const result = validate({ ...enabled, MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "false" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Funded AI runtime provisioning requires the control plane");
  });

  it.each([
    { MATRIX_FUNDED_AI_MODEL_PROBE_DAILY_LIMIT: "0" },
    { MATRIX_FUNDED_AI_MODEL_PROBE_MINUTE_LIMIT: "0" },
    { MATRIX_FUNDED_AI_MODEL_PROBE_DAILY_LIMIT: "10001" },
    { MATRIX_FUNDED_AI_MODEL_PROBE_MINUTE_LIMIT: "101" },
    { MATRIX_FUNDED_AI_MODEL_PROBE_MINUTE_LIMIT: "11" },
    { MATRIX_FUNDED_AI_RELAY_URL: "http://relay.example.com" },
    { MATRIX_FUNDED_AI_RELAY_URL: "https://relay.example.com/path" },
  ])("retains Relay and probe-budget validation for control-only acceptance: %j", invalid => {
    const result = validate({ ...enabled, MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false", ...invalid });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/positive bounded integer|budget bounds|HTTPS origin/);
  });

  it.each([
    { MATRIX_FUNDED_AI_MODEL_PROBE_DAILY_LIMIT: "" },
    { MATRIX_FUNDED_AI_MODEL_PROBE_MINUTE_LIMIT: "" },
    { MATRIX_FUNDED_AI_MODEL_PROBE_DAILY_LIMIT: "0" },
    { MATRIX_FUNDED_AI_MODEL_PROBE_MINUTE_LIMIT: "0" },
    { MATRIX_FUNDED_AI_MODEL_PROBE_DAILY_LIMIT: "10001" },
    { MATRIX_FUNDED_AI_MODEL_PROBE_MINUTE_LIMIT: "101" },
    { MATRIX_FUNDED_AI_MODEL_PROBE_MINUTE_LIMIT: "11" },
    { MATRIX_FUNDED_AI_MODEL_PROBE_DAILY_LIMIT: "1.5" },
    { MATRIX_FUNDED_AI_MODEL_PROBE_MINUTE_LIMIT: "typo" },
  ])("rejects an enabled deployment without a valid bounded probe budget: %j", (invalid) => {
    expect(validate({ ...enabled, ...invalid }).status).not.toBe(0);
  });

  it("accepts reviewed positive limits while preserving disabled checkout", () => {
    expect(validate(enabled).status).toBe(0);
    expect(workflow.jobs.deploy.env.MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED).toContain("'false'");
  });

  it("keeps control secrets and probe limits mounted during control-only acceptance", () => {
    const script = step("Deploy tagged revision").split("candidate_url=")[0];
    const deployed = spawnSync("bash", ["-c", `
      gcloud() { if [ "$2 $3" = "services describe" ]; then return 1; fi; printf '%s\\n' "$@"; }
      ${script}
      printf '%s\\n' "$deploy_json"
    `], { encoding: "utf8", env: { ...env, ...Object.fromEntries(
      Object.keys(workflow.jobs.deploy.env).map(name => [name, "fixture"])),
      ...creditReleaseDefaults,
      MATRIX_CARD_TRIAL_DAYS: "3", MATRIX_STARTER_TRIAL_DAYS: "14",
      GOOGLE_TAG_MANAGER_ID: "GTM-TEST123", GOOGLE_ANALYTICS_MEASUREMENT_ID: "",
      GOOGLE_ANALYTICS_API_SECRET_VERSION: "1",
      WHATSAPP_ENABLED: "false", WHATSAPP_ENCRYPTION_KEY_VERSION: "1",
      ACCOUNT_DELETION_CONFIGURED: "false", ACCOUNT_DELETION_ENABLED: "false",
      IMAGE_DIGEST: "image@sha256:fixture", ...enabled,
      MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false" } });
    expect(deployed.status, deployed.stderr).toBe(0);
    expect(deployed.stdout).toContain("MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED=true");
    expect(deployed.stdout).toContain("MATRIX_FUNDED_AI_RUNTIME_ENABLED=false");
    expect(deployed.stdout).toContain("MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED=false");
    expect(deployed.stdout).toContain("MATRIX_FUNDED_AI_RELAY_URL=https://relay.example.com");
    expect(deployed.stdout).toContain("MATRIX_FUNDED_AI_MODEL_PROBE_DAILY_LIMIT=10");
    expect(deployed.stdout).toContain("MATRIX_FUNDED_AI_MODEL_PROBE_MINUTE_LIMIT=1");
    expect(deployed.stdout).toContain("AI_RELAY_CONTROL_TOKEN=ai-relay-control-token:latest");
    expect(deployed.stdout).toContain("AI_FUNDED_CREDENTIAL_HASH_SECRET=ai-funded-credential-hash-secret:latest");
    expect(deployed.stdout).not.toContain("STRIPE_PRICE_AI_CREDIT_USD_5=");
  });

  it.each(["MATRIX_FUNDED_AI_MODEL_PROBE_DAILY_LIMIT", "MATRIX_FUNDED_AI_MODEL_PROBE_MINUTE_LIMIT"])(
    "wires %s from GitHub variables to the actual Cloud Run deployment", (key) => {
      expect(workflow.jobs.deploy.env[key]).toContain(`vars.${key}`);
      const script = step("Deploy tagged revision").split("candidate_url=")[0];
      const deployed = spawnSync("bash", ["-c", `
        gcloud() { if [ "$2 $3" = "services describe" ]; then return 1; fi; printf '%s\\n' "$@"; }
        ${script}
        printf '%s\\n' "$deploy_json"
      `], { encoding: "utf8", env: { ...env, ...Object.fromEntries(
        Object.keys(workflow.jobs.deploy.env).map((name) => [name, "fixture"])),
        ...creditReleaseDefaults,
        MATRIX_CARD_TRIAL_DAYS: "3", MATRIX_STARTER_TRIAL_DAYS: "14",
        GOOGLE_TAG_MANAGER_ID: "GTM-TEST123", GOOGLE_ANALYTICS_MEASUREMENT_ID: "",
        GOOGLE_ANALYTICS_API_SECRET_VERSION: "1",
        WHATSAPP_ENABLED: "false", WHATSAPP_ENCRYPTION_KEY_VERSION: "1",
        ACCOUNT_DELETION_CONFIGURED: "false", ACCOUNT_DELETION_ENABLED: "false",
        IMAGE_DIGEST: "image@sha256:fixture", ...enabled } });
      expect(deployed.status, deployed.stderr).toBe(0);
      expect(deployed.stdout).toContain(`${key}=${enabled[key as keyof typeof enabled]}`);
    });
});

describe("funded control-plane effective secret access", () => {
  const member = "serviceAccount:platform@fixture.iam.gserviceaccount.com";
  const binding = { role: "roles/secretmanager.secretAccessor", members: [member] };
  const policy = (bindings: unknown[]) => JSON.stringify({ bindings });
  function verify(secretPolicy: string, projectPolicy: string, failures: Record<string, string> = {}) {
    return spawnSync("bash", ["-c", `
      gcloud() {
        case "$1 $2 $3" in
          'secrets versions describe') return 0 ;;
          'secrets get-iam-policy '* )
            if [ "\${SECRET_POLICY_FAILURE:-false}" = true ]; then return 1; fi
            printf '%s\\n' "$SECRET_POLICY" ;;
          'projects get-iam-policy '* )
            if [ "\${PROJECT_POLICY_FAILURE:-false}" = true ]; then return 1; fi
            printf '%s\\n' "$PROJECT_POLICY" ;;
          *) return 1 ;;
        esac
      }
      ${step("Verify funded AI control-plane secrets")}
    `], { encoding: "utf8", env: { PATH: process.env.PATH, GCP_PROJECT_ID: "fixture",
      CLOUD_RUN_SERVICE_ACCOUNT: "platform@fixture.iam.gserviceaccount.com",
      SECRET_POLICY: secretPolicy, PROJECT_POLICY: projectPolicy, ...failures } });
  }
  it("accepts unconditional secret-level access without requiring any project grant", () => {
    const result = verify(policy([binding]), policy([]), { PROJECT_POLICY_FAILURE: "true" });
    expect(result.status, result.stderr).toBe(0);
  });
  it("recognizes an existing unconditional project-level accessor without granting a new role", () => {
    const result = verify(policy([]), policy([binding]));
    expect(result.status, result.stderr).toBe(0);
  });
  it.each([
    [policy([]), policy([]), {}],
    [policy([]), policy([{ ...binding, members: ["serviceAccount:other@fixture.iam.gserviceaccount.com"] }]), {}],
    [policy([{ ...binding, condition: { expression: "true" } }]), policy([]), {}],
    [policy([]), policy([{ ...binding, condition: { expression: "true" } }]), {}],
    [policy([]), policy([binding]), { PROJECT_POLICY_FAILURE: "true" }],
    [policy([]), policy([binding]), { SECRET_POLICY_FAILURE: "true" }],
    ["not-json", policy([binding]), {}],
    [JSON.stringify({ bindings: "malformed" }), policy([binding]), {}],
    [policy([{ ...binding, members: "malformed" }]), policy([binding]), {}],
    [policy([]), "not-json", {}],
  ])("fails closed when unconditional effective access is not established: %j", (secretPolicy, projectPolicy, failures) => {
    expect(verify(secretPolicy as string, projectPolicy as string, failures as Record<string, string>).status).not.toBe(0);
  });
});
}

{
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
}
