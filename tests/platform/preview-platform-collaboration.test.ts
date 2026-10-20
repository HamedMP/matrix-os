import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { describePlatformCollaborationConfiguration } from "../../packages/platform/src/collaboration/wiring.js";

const workflowText = readFileSync(".github/workflows/preview-platform.yml", "utf8");
const job = YAML.parse(workflowText).jobs.preview;
type Step = { name?: string; run?: string };
const stepNames: string[] = job.steps.map((step: Step) => step.name ?? "");
const stepRun = (name: string): string => {
  const run = job.steps.find((step: Step) => step.name === name)?.run;
  expect(typeof run, name).toBe("string");
  return run as string;
};
const validation = stepRun("Check preview configuration");
const deployment = stepRun("Deploy zero-traffic tagged revision to preview service");
const VERIFY_STEP = "Verify preview collaboration ticket secret";
const PREVIEW_SECRET = "collaboration-ticket-keys-preview";
const PREVIEW_HOST = "https://preview.matrix-os.com";
const ACTIVE_KEY_ID = "collaboration-preview-v1";
const RUNNER = "synthetic-preview-runner@example.test";

function baseEnvironment(overrides: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH,
    GITHUB_OUTPUT: "/dev/null",
    CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform-preview",
    CLOUD_RUN_SERVICE_ACCOUNT: RUNNER,
    MATRIX_CARD_TRIALS_ENABLED: "true",
    MATRIX_CARD_TRIAL_DAYS: "3", MATRIX_STARTER_TRIAL_DAYS: "14",
    MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "false",
    MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false",
    MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: ACTIVE_KEY_ID,
    PREVIEW_PUBLIC_URL: PREVIEW_HOST,
    ...overrides,
  };
}

function validate(overrides: Record<string, string>) {
  return spawnSync("bash", ["-euc", validation], { env: baseEnvironment(overrides), encoding: "utf8", timeout: 5_000 });
}

function deployedArguments(overrides: Record<string, string> = {}, apiOrigin = "https://synthetic-preview.example.test") {
  const directory = mkdtempSync(join(tmpdir(), "preview-collaboration-deploy-"));
  const capture = join(directory, "arguments");
  try {
    // Execute the workflow's own setup and deploy function with a stubbed gcloud;
    // no Cloud Run, credentials, network or database is used.
    const functionEnd = deployment.indexOf("\nservice_base_url=");
    expect(functionEnd).toBeGreaterThan(0);
    const script = `gcloud() { if [ "$1 $2 $3" = "secrets versions describe" ]; then printf '%s' '{"state":"ENABLED","name":"projects/synthetic-project/secrets/platform-preview-secret/versions/7"}'; else printf '%s\\0' "$@" > "$CAPTURE"; fi; }\ndate() { printf '%s\\n' '2026-09-28T00:00:00.000Z'; }\n${deployment.slice(0, functionEnd)}\ndeploy_preview "$DEPLOY_API_ORIGIN"`;
    const result = spawnSync("bash", ["-euc", script], { encoding: "utf8", timeout: 5_000, env: {
      ...baseEnvironment(overrides), CAPTURE: capture, CUSTOM_MCP_ENABLED: "false",
      GCP_PROJECT_ID: "synthetic-project", GCP_REGION: "synthetic-region", PR_NUMBER: "1990",
      IMAGE: "synthetic-image:603751f4885c",
      DEPLOY_API_ORIGIN: apiOrigin,
    } });
    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(capture, "utf8").split("\0");
    return {
      env: args[args.indexOf("--set-env-vars") + 1]!,
      secrets: args[args.indexOf("--set-secrets") + 1]!,
    };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function revisionContract(revision: unknown, overrides: Record<string, string> = {}, apiOrigin?: string) {
  const functionEnd = deployment.indexOf("\nservice_base_url=");
  const script = `gcloud() { if [ "$1 $2 $3" = "secrets versions describe" ]; then printf '%s' '{"state":"ENABLED","name":"projects/synthetic-project/secrets/platform-preview-secret/versions/7"}'; fi; }\ndate() { printf '%s\\n' '2026-09-28T00:00:00.000Z'; }\n${deployment.slice(0, functionEnd)}\n${apiOrigin ? 'deploy_preview "$DEPLOY_API_ORIGIN"' : ''}\nverify_collaboration_revision <<< "$REVISION_JSON"`;
  return spawnSync("bash", ["-euc", script], { encoding: "utf8", timeout: 5_000, env: {
    ...baseEnvironment(overrides), REVISION_JSON: JSON.stringify(revision), DEPLOY_API_ORIGIN: apiOrigin,
    CUSTOM_MCP_ENABLED: "false", GCP_PROJECT_ID: "synthetic-project", GCP_REGION: "synthetic-region",
    CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform-preview", PR_NUMBER: "2079", IMAGE: "synthetic-image:pinned",
  } });
}

function connectionOriginContract(revision: unknown, expectedRelay: string) {
  const connection = YAML.parse(workflowText).jobs["connect-slack-pilot-preview"];
  const target = connection.steps.find((step: Step) => step.name === "Check PR, identity, and exact tagged preview")?.run;
  expect(typeof target).toBe("string");
  const start = target.indexOf('client_origins="$(jq -er --arg alias');
  const end = target.indexOf('\n[[ "$url"', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  // Execute only the real revision-origin validation: no cloud/auth/VM commands.
  const script = `revision_json="$REVISION_JSON"\nurl="$EXPECTED_RELAY"\n${target.slice(start, end)}\nprintf '%s' "$client_origins"`;
  return spawnSync("bash", ["-euc", script], {
    encoding: "utf8", timeout: 5_000,
    env: { PATH: process.env.PATH, PR_NUMBER: "2079", REVISION_JSON: JSON.stringify(revision), EXPECTED_RELAY: expectedRelay },
  });
}

function seed(): string {
  return randomBytes(32).toString("base64url");
}

function verifySecret(keyring: string, accessor = `serviceAccount:${RUNNER}`) {
  const directory = mkdtempSync(join(tmpdir(), "preview-collaboration-verify-"));
  try {
    const calls = join(directory, "calls");
    const gcloud = join(directory, "gcloud");
    writeFileSync(gcloud, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  "secrets versions access"*) printf '%s' "$KEYRING" ;;
  "secrets get-iam-policy"*) printf '%s\\n' "$ACCESSOR" ;;
esac
`);
    chmodSync(gcloud, 0o755);
    const result = spawnSync("bash", ["-euc", stepRun(VERIFY_STEP)], { encoding: "utf8", timeout: 5_000, env: {
      ...baseEnvironment(), PATH: `${directory}:${process.env.PATH}`, CALLS: calls, KEYRING: keyring,
      ACCESSOR: accessor, GCP_PROJECT_ID: "synthetic-project",
    } });
    return { ...result, calls: readFileSync(calls, "utf8") };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("preview platform collaboration authority", () => {
  it("preserves only explicitly supplied preview Slack bindings through deployment", () => {
    const isolated = deployedArguments({
      SLACK_PREVIEW_ENV_BINDINGS: "|SLACK_APP_ID=AEXAMPLE|SLACK_PREVIEW_RUNTIME_HANDLE=pr-1990",
      SLACK_PREVIEW_SECRET_BINDINGS: ",SLACK_SIGNING_SECRET=slack-preview-pr1990-signing-secret:1",
      SLACK_PREVIEW_DATABASE_SECRET_BINDING: "slack-preview-pr1990-platform-database-url:1",
    });
    expect(isolated.env).toContain("|SLACK_APP_ID=AEXAMPLE|SLACK_PREVIEW_RUNTIME_HANDLE=pr-1990");
    expect(isolated.secrets).toContain(",SLACK_SIGNING_SECRET=slack-preview-pr1990-signing-secret:1");
    expect(isolated.secrets.split(",")).toContain("PLATFORM_DATABASE_URL=slack-preview-pr1990-platform-database-url:1");
    expect(isolated.secrets).not.toContain("platform-database-url-staging");
    const normal = deployedArguments();
    expect(normal.env).not.toContain("SLACK_APP_ID");
    expect(normal.secrets).not.toContain("SLACK_SIGNING_SECRET");
    expect(normal.secrets.split(",")).toContain("PLATFORM_DATABASE_URL=platform-database-url-staging:latest");
  });
  it("binds ticket keys only from the preview-only secret, never the production one", () => {
    const { secrets } = deployedArguments();
    expect(secrets.split(",")).toContain(`MATRIX_COLLABORATION_TICKET_KEYS=${PREVIEW_SECRET}:latest`);
    // The production keyring is `collaboration-ticket-keys`; a preview must never mount or read it.
    expect(workflowText).not.toMatch(/collaboration-ticket-keys(?!-preview)/);
  });

  it("sources the active key id from a preview-only variable", () => {
    expect(job.environment).toBe("Preview");
    expect(job.env.MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID)
      .toBe(`\${{ vars.PREVIEW_COLLABORATION_TICKET_ACTIVE_KEY_ID || '${ACTIVE_KEY_ID}' }}`);
    expect(deployedArguments().env.split("|")).toContain(`MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID=${ACTIVE_KEY_ID}`);
  });

  it("sets the allowed and relay origins to the preview host so the real composition boots", () => {
    const bindings = deployedArguments().env.split("|");
    expect(bindings).toContain(`MATRIX_COLLABORATION_ALLOWED_ORIGINS=${PREVIEW_HOST}`);
    expect(bindings).toContain(`MATRIX_COLLABORATION_RELAY_ORIGIN=${PREVIEW_HOST}`);
    const env = Object.fromEntries(bindings.filter((binding) => binding.includes("=")).map((binding) => {
      const separator = binding.indexOf("=");
      return [binding.slice(0, separator), binding.slice(separator + 1)];
    }));
    const health = describePlatformCollaborationConfiguration({
      ...env, MATRIX_COLLABORATION_TICKET_KEYS: JSON.stringify({ [ACTIVE_KEY_ID]: seed() }),
    });
    expect(health.configured).toBe(true);
    if (!health.configured) return;
    expect(health.config.relayOrigin).toBe(PREVIEW_HOST);
    expect(health.config.allowedOrigins).toEqual([PREVIEW_HOST]);
    expect(health.config.ticketKeyring?.activeKeyId).toBe(ACTIVE_KEY_ID);
  });

  const pilotAlias="https://pr-2079-preview.matrix-os.com";
  const pilotBackend="https://pr-2079---matrix-platform-preview-example-ey.a.run.app";
  const pilotBrowser="https://app.matrix-os.com";
  const pilotOverrides={SLACK_PREVIEW_ENABLED:"true",SLACK_PREVIEW_BROWSER_ORIGIN:pilotBrowser,PREVIEW_PUBLIC_URL:pilotAlias};

  function connectionRevision(browserOrigin: string) {
    const overrides = { ...pilotOverrides, SLACK_PREVIEW_BROWSER_ORIGIN: browserOrigin };
    const bindings = deployedArguments(overrides, pilotBackend).env.split("|");
    const env: { name: string; value?: string; valueFrom?: { secretKeyRef: { name: string; key: string } } }[] = bindings.filter(binding => /^MATRIX_COLLABORATION_(ALLOWED_ORIGINS|RELAY_ORIGIN)=/.test(binding)).map(binding => {
      const separator = binding.indexOf("=");
      return { name: binding.slice(0, separator), value: binding.slice(separator + 1) };
    });
    env.push({ name: "MATRIX_COLLABORATION_TICKET_KEYS", valueFrom: { secretKeyRef: { name: PREVIEW_SECRET, key: "latest" } } });
    return { spec: { containers: [{ env }] } };
  }

  it.each(["https://qualification.matrix-os.com", pilotBrowser])("connects the deployed tagged relay with only configured browser origins (%s)", browser => {
    const revision = connectionRevision(browser);
    const result = connectionOriginContract(revision, pilotBackend);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${pilotAlias},${browser}`);
    expect(result.stdout.split(",")).not.toContain(pilotBackend);
  });

  it.each([pilotAlias, "https://foreign-relay.example.test"])("rejects relay %s even when it appears in browser origins", relay => {
    const revision = connectionRevision(pilotBrowser);
    const env = revision.spec.containers[0]!.env;
    env.find(value => value.name === "MATRIX_COLLABORATION_RELAY_ORIGIN")!.value = relay;
    env.find(value => value.name === "MATRIX_COLLABORATION_ALLOWED_ORIGINS")!.value = `${pilotAlias},${pilotBrowser},${relay}`;
    expect(connectionOriginContract(revision, pilotBackend).status).not.toBe(0);
  });

  it.each(["missing-alias", "invalid-origin", "over-cap", "duplicate-relay", "wrong-key"])("keeps connection origin fence %s", failure => {
    const revision = connectionRevision(pilotBrowser);
    const env = revision.spec.containers[0]!.env;
    const allowed = env.find(value => value.name === "MATRIX_COLLABORATION_ALLOWED_ORIGINS")!;
    if (failure === "missing-alias") allowed.value = pilotBackend;
    if (failure === "invalid-origin") allowed.value = `${pilotAlias},http://insecure.example.test`;
    if (failure === "over-cap") allowed.value = [pilotAlias, ...Array.from({ length: 16 }, (_, index) => `https://origin-${index}.example.test`)].join(",");
    if (failure === "duplicate-relay") env.push({ name: "MATRIX_COLLABORATION_RELAY_ORIGIN", value: pilotBackend });
    if (failure === "wrong-key") env.find(value => value.name === "MATRIX_COLLABORATION_TICKET_KEYS")!.valueFrom!.secretKeyRef.name = "wrong-preview-key";
    expect(connectionOriginContract(revision, pilotBackend).status).not.toBe(0);
  });

  it("advertises the exact pilot backend for collaboration while preserving the sign-in alias",()=>{
    const bindings=deployedArguments(pilotOverrides,pilotBackend).env.split("|");
    expect(bindings).toContain(`PLATFORM_PUBLIC_URL=${pilotAlias}`);
    expect(bindings).toContain(`MATRIX_APP_ORIGIN=${pilotAlias}`);
    expect(bindings).toContain(`MATRIX_API_ORIGIN=${pilotBackend}`);
    expect(bindings).toContain(`MATRIX_COLLABORATION_ALLOWED_ORIGINS=${pilotAlias},${pilotBrowser}`);
    expect(bindings).toContain(`MATRIX_COLLABORATION_RELAY_ORIGIN=${pilotBackend}`);
    const values=Object.fromEntries(bindings.filter(binding=>binding.includes("=")).map(binding=>{
      const separator=binding.indexOf("=");return [binding.slice(0,separator),binding.slice(separator+1)];
    }));
    const health=describePlatformCollaborationConfiguration({...values,MATRIX_COLLABORATION_TICKET_KEYS:JSON.stringify({[ACTIVE_KEY_ID]:seed()})});
    expect(health.configured).toBe(true);
    if(health.configured){expect(health.config.relayOrigin).toBe(pilotBackend);expect(health.config.allowedOrigins).toEqual([pilotAlias,pilotBrowser]);}
  });

  it("requires the pilot revision readback to match the reachable collaboration backend",()=>{
    const revision=(relay:string)=>({spec:{containers:[{env:[
      {name:"MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID",value:ACTIVE_KEY_ID},
      {name:"MATRIX_COLLABORATION_ALLOWED_ORIGINS",value:`${pilotAlias},${pilotBrowser}`},
      {name:"MATRIX_COLLABORATION_RELAY_ORIGIN",value:relay},
      {name:"MATRIX_COLLABORATION_TICKET_KEYS",valueFrom:{secretKeyRef:{name:PREVIEW_SECRET,key:"latest"}}},
    ]}]}});
    expect(revisionContract(revision(pilotBackend),pilotOverrides,pilotBackend).status).toBe(0);
    expect(revisionContract(revision(pilotAlias),pilotOverrides,pilotBackend).status).not.toBe(0);
  });

  it.each([
    { MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "" },
    { MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "key id with spaces" },
    { MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "k".repeat(81) },
    { PREVIEW_PUBLIC_URL: "http://preview.matrix-os.com" },
    { PREVIEW_PUBLIC_URL: "https://preview.matrix-os.com/path" },
    { PREVIEW_PUBLIC_URL: "https://preview.matrix-os.com|MATRIX_EXTRA=1" },
    { PREVIEW_PUBLIC_URL: "https://app.matrix-os.com" },
    { PREVIEW_PUBLIC_URL: "https://api.matrix-os.com/" },
  ])("refuses unsafe collaboration configuration %j before deployment", (overrides) => {
    const result = validate(overrides);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/collaboration|PREVIEW_PUBLIC_URL/i);
  });

  it("accepts the default preview configuration", () => {
    const result = validate({});
    expect(result.status, result.stderr).toBe(0);
    expect(validate({ PREVIEW_PUBLIC_URL: `${PREVIEW_HOST}/` }).status).toBe(0);
  });

  it("verifies the preview keyring, its active key and the runner grant before deploying", () => {
    const verifyIndex = stepNames.indexOf(VERIFY_STEP);
    expect(verifyIndex).toBeGreaterThan(stepNames.indexOf("Authenticate to Google Cloud"));
    expect(verifyIndex).toBeLessThan(stepNames.indexOf("Deploy zero-traffic tagged revision to preview service"));
    const activeSeed = seed();
    const accepted = verifySecret(JSON.stringify({ [ACTIVE_KEY_ID]: activeSeed, "collaboration-preview-v0": seed() }));
    expect(accepted.status, accepted.stderr).toBe(0);
    for (const line of accepted.calls.trim().split("\n")) {
      expect(line).toMatch(new RegExp(`^secrets .*${PREVIEW_SECRET}( |$)`));
    }
    expect(accepted.calls).toContain("secrets versions access latest");
    expect(`${accepted.stdout}${accepted.stderr}`).not.toContain(activeSeed);
  });

  it.each([
    ["missing active key", JSON.stringify({ "collaboration-preview-v0": seed() })],
    ["short seed", JSON.stringify({ [ACTIVE_KEY_ID]: "c2hvcnQ" })],
    ["non-object keyring", JSON.stringify([seed()])],
    ["unparseable keyring", "not json"],
    ["too many keys", JSON.stringify(Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`k${index}`, seed()]).concat([[ACTIVE_KEY_ID, seed()]])))],
  ])("refuses a preview keyring with a %s", (_label, keyring) => {
    const result = verifySecret(keyring);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(PREVIEW_SECRET);
  });

  it("refuses a keyring the preview runner cannot read", () => {
    const result = verifySecret(JSON.stringify({ [ACTIVE_KEY_ID]: seed() }), "serviceAccount:someone-else@example.test");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("secretAccessor");
  });

  it("confirms the tagged revision carries the preview binding and serves the real composition", () => {
    const env = (keys: string) => [
      { name: "MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID", value: ACTIVE_KEY_ID },
      { name: "MATRIX_COLLABORATION_ALLOWED_ORIGINS", value: PREVIEW_HOST },
      { name: "MATRIX_COLLABORATION_RELAY_ORIGIN", value: PREVIEW_HOST },
      { name: "MATRIX_COLLABORATION_TICKET_KEYS", valueFrom: { secretKeyRef: { name: keys, key: "latest" } } },
    ];
    const revision = (keys: string) => ({ spec: { containers: [{ env: env(keys) }] } });
    expect(revisionContract(revision(PREVIEW_SECRET)).status).toBe(0);
    expect(revisionContract(revision("collaboration-ticket-keys")).status).not.toBe(0);
    expect(revisionContract({ spec: { containers: [{ env: env(PREVIEW_SECRET).slice(1) }] } }).status).not.toBe(0);
    const tail = deployment.slice(deployment.indexOf("\nservice_base_url="));
    expect(tail).toContain("verify_collaboration_revision");
    // A fail-closed composition answers every collaboration route with 503; the real one asks for credentials.
    expect(tail).toContain('"${PREVIEW_API_ORIGIN}/api/collaboration/inbox"');
    expect(tail).toContain('[ "$collaboration_status" = "401" ]');
  });
});
