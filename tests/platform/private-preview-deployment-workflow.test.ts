import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

interface DeploymentStep {
  name: string;
  run?: string;
}
const deployment = (
  YAML.parse(
    readFileSync(
      join(process.cwd(), ".github/workflows/platform-cloud-run.yml"),
      "utf8",
    ),
  ) as {
    jobs: { deploy: { env: Record<string, string>; steps: DeploymentStep[] } };
  }
).jobs.deploy;
const step = (name: string) =>
  deployment.steps.find((candidate) => candidate.name === name)!.run!;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const defaults: NodeJS.ProcessEnv = {
  GCP_PROJECT_ID: "fixture-project",
  GCP_REGION: "fixture-region",
  ARTIFACT_REPOSITORY: "fixture-repository",
  CLOUD_RUN_SERVICE: "fixture-service",
  CLOUD_RUN_SERVICE_ACCOUNT: "fixture-account",
  PLATFORM_PUBLIC_URL: "https://platform.example.com",
  MATRIX_API_ORIGIN: "https://api.example.com",
  MATRIX_APP_URL: "https://app.example.com",
  MATRIX_APP_DOMAIN_HOSTS: "app.example.com",
  MATRIX_CODE_DOMAIN_HOSTS: "code.example.com",
  MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "fixture-v1",
  MATRIX_COLLABORATION_ALLOWED_ORIGINS: "https://app.example.com",
  DEPLOY_ENVIRONMENT: "staging",
  CUSTOM_MCP_ENABLED: "false",
  GOLDEN_SNAPSHOT_BUILDS_ENABLED: "false",
  MATRIX_CARD_TRIALS_ENABLED: "true",
  MATRIX_CARD_TRIAL_DAYS: "3",
  MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE: "4",
  MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "false",
  MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false",
  MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: "false",
  PLATFORM_SPEECH_ENABLED: "false",
  MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED: "false",
  WHATSAPP_ENABLED: "false",
  CUSTOMER_VPS_IMAGE_VERSION: "stable",
  MATRIX_PREBILLING_PROVISIONING_ENABLED: "true",
  MATRIX_PREBILLING_PROVISIONING_ROLLOUT_PERCENT: "100",
  GOLDEN_SNAPSHOTS_ENABLED: "true",
  GOLDEN_SNAPSHOT_ROLLOUT_PERCENT: "100",
  CANDIDATE_REVISION: "fixture-candidate",
};

function validate(organization: string | undefined) {
  return spawnSync("bash", ["-c", step("Validate deployment configuration")], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...defaults,
      MATRIX_INTERNAL_CLERK_ORG_ID: organization,
    },
  });
}

function verify(
  expectedOrganization: string,
  actualOrganization: string | undefined,
) {
  const directory = mkdtempSync(
    join(tmpdir(), "matrix-private-preview-deployment-"),
  );
  directories.push(directory);
  const env = Object.entries(defaults).map(([name, value]) => ({
    name,
    value,
  }));
  if (actualOrganization !== undefined)
    env.push({
      name: "MATRIX_INTERNAL_CLERK_ORG_ID",
      value: actualOrganization,
    });
  const secretEnv = [
    ["MATRIX_COLLABORATION_TICKET_KEYS", "collaboration-ticket-keys", "latest"],
    [
      "STRIPE_PRICE_MATRIX_STARTER_MONTHLY",
      "stripe-price-matrix-starter-monthly-2026-08-31",
      "1",
    ],
    [
      "STRIPE_PRICE_MATRIX_BUILDER_MONTHLY",
      "stripe-price-matrix-builder-monthly-2026-08-31",
      "1",
    ],
    [
      "STRIPE_PRICE_MATRIX_MAX_MONTHLY",
      "stripe-price-matrix-max-monthly-2026-08-31",
      "1",
    ],
  ].map(([name, secret, key]) => ({
    name,
    valueFrom: { secretKeyRef: { name: secret, key } },
  }));
  writeFileSync(
    join(directory, "gcloud"),
    "#!/usr/bin/env bash\nprintf '%s' \"$FIXTURE_REVISION\"\n",
  );
  chmodSync(join(directory, "gcloud"), 0o700);
  return spawnSync(
    "bash",
    ["-c", step("Verify deployed provisioning contract")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...defaults,
        PATH: `${directory}:${process.env.PATH}`,
        MATRIX_INTERNAL_CLERK_ORG_ID: expectedOrganization,
        FIXTURE_REVISION: JSON.stringify({
          spec: { containers: [{ env: [...env, ...secretEnv] }] },
        }),
      },
    },
  );
}

describe("Private Preview Cloud Run configuration", () => {
  it("binds the optional organization from GitHub configuration across full environment replacement", () => {
    expect(deployment.env.MATRIX_INTERNAL_CLERK_ORG_ID).toBe(
      "${{ vars.MATRIX_INTERNAL_CLERK_ORG_ID }}",
    );
    const deploy = step("Deploy tagged revision");
    const envBinding = deploy
      .split("\n")
      .find((line) => line.includes("--set-env-vars"))!;
    expect(envBinding).toContain(
      "MATRIX_INTERNAL_CLERK_ORG_ID=${MATRIX_INTERNAL_CLERK_ORG_ID}",
    );
    expect(step("Verify production provisioning contract")).toContain(
      '"MATRIX_INTERNAL_CLERK_ORG_ID=${MATRIX_INTERNAL_CLERK_ORG_ID}"',
    );
  });

  it.each([undefined, "", "org_fixture42"])(
    "accepts optional valid organization %s without requiring preview eligibility",
    (organization) => {
      const result = validate(organization);
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it.each([
    "org_",
    "org_fixture|UNEXPECTED=true",
    " org_fixture",
    "org_fixture\n",
    "user_fixture",
    `org_${"a".repeat(125)}`,
  ])(
    "rejects malformed configured organization without logging its value",
    (organization) => {
      const result = validate(organization);
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain(organization);
    },
  );

  it("verifies exact organization binding and refuses omitted or mismatched deployed configuration", () => {
    expect(verify("org_fixture42", "org_fixture42").status).toBe(0);
    expect(verify("org_fixture42", undefined).status).not.toBe(0);
    expect(verify("org_fixture42", "org_otherFixture").status).not.toBe(0);
    expect(verify("", "").status).toBe(0);
    expect(verify("", "org_otherFixture").status).not.toBe(0);
  });
});
