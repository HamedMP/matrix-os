import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

type Step = { name?: string; run?: string; if?: string };
const production = YAML.parse(readFileSync(".github/workflows/platform-cloud-run.yml", "utf8")).jobs.deploy;
const preview = YAML.parse(readFileSync(".github/workflows/preview-platform.yml", "utf8")).jobs.preview;
const org = "org_SyntheticPreview123";
const validationName = "Validate Private Preview organization configuration";
const run = (job: typeof production, name: string): string => {
  const script = job.steps.find((entry: Step) => entry.name === name)?.run;
  expect(script, name).toBeTypeOf("string");
  return script;
};

function validate(job: typeof production, value: string, environment: string) {
  return spawnSync("bash", ["-euc", run(job, validationName)], {
    encoding: "utf8", timeout: 5_000,
    env: { PATH: process.env.PATH, MATRIX_INTERNAL_CLERK_ORG_ID: value, DEPLOY_ENVIRONMENT: environment },
  });
}

function deploy(job: typeof production, value: string) {
  const isPreview = job === preview;
  const deployment = run(job, isPreview
    ? "Deploy zero-traffic tagged revision to preview service" : "Deploy tagged revision");
  const end = deployment.indexOf(isPreview ? "\nservice_base_url=" : "candidate_url=");
  expect(end).toBeGreaterThan(0);
  // Execute the actual workflow command against shell stubs, without Cloud Run/network access.
  const script = `gcloud() { if [ "$2 $3" = "services describe" ]; then return 1; fi; if [ "$1 $2 $3" = "secrets versions describe" ]; then printf ENABLED; return; fi; printf '%s\\n' "$@"; }\ndate() { printf '%s\\n' '2026-10-13T00:00:00.000Z'; }\n${deployment.slice(0, end)}\n${isPreview ? "deploy_preview https://preview.example.test" : 'printf \'%s\\n\' "$deploy_json"'}`;
  return spawnSync("bash", ["-euc", script], { encoding: "utf8", timeout: 5_000, env: {
    PATH: process.env.PATH,
    ...Object.fromEntries(Object.keys(job.env).map((key) => [key, "fixture"])),
    MATRIX_INTERNAL_CLERK_ORG_ID: value, DEPLOY_ENVIRONMENT: "staging",
    MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "false", MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false",
    MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: "false", MATRIX_FUNDED_HOST_CONFIG_ENABLED: "false",
    CUSTOM_MCP_ENABLED: "false", PLATFORM_SPEECH_ENABLED: "false", WHATSAPP_ENABLED: "false",
    ACCOUNT_DELETION_CONFIGURED: "false", ACCOUNT_DELETION_ENABLED: "false",
    WHATSAPP_ENCRYPTION_KEY_VERSION: "1", IMAGE: "synthetic-image", IMAGE_DIGEST: "synthetic-image",
    GOOGLE_TAG_MANAGER_ID: "GTM-SYNTHETIC", GOOGLE_ANALYTICS_MEASUREMENT_ID: "G-SYNTHETIC123",
    GOOGLE_ANALYTICS_API_SECRET_VERSION: "2",
  } });
}

describe("Private Preview organization deployment contract", () => {
  it.each([["production", production], ["Preview", preview]])("binds %s configuration through the environment/repository variable", (_label, job) => {
    expect(job.env.MATRIX_INTERNAL_CLERK_ORG_ID).toBe("${{ vars.MATRIX_INTERNAL_CLERK_ORG_ID }}");
    const index = job.steps.findIndex((entry: Step) => entry.name === validationName);
    const deployIndex = job.steps.findIndex((entry: Step) => entry.name?.startsWith("Deploy "));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(deployIndex);
    if (job === preview) expect(job.steps[index].if).toBe("steps.config.outputs.configured == 'true'");
  });

  it("requires an explicit internal organization for production, but allows disabled staging and Preview", () => {
    const missing = validate(production, "", "production");
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("MATRIX_INTERNAL_CLERK_ORG_ID");
    expect(validate(production, "", "staging").status).toBe(0);
    expect(validate(preview, "", "Preview").status).toBe(0);
    expect(validate(production, org, "production").status).toBe(0);
    expect(validate(preview, org, "Preview").status).toBe(0);
  });

  it.each(["org_", "user_Synthetic", "org_bad-id", "org_a|INJECTED=true", "org_a\n", `org_${"a".repeat(125)}`])("rejects invalid configuration before deployment: %j", (value) => {
    for (const job of [production, preview]) {
      const result = validate(job, value, "staging");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("MATRIX_INTERNAL_CLERK_ORG_ID");
      expect(result.stderr).not.toContain(value);
    }
  });

  it.each([["production", production], ["Preview", preview]])("preserves the organization in the actual %s replacement env argument", (_label, job) => {
    for (const value of [org, ""]) {
      const result = deploy(job, value);
      expect(result.status, result.stderr).toBe(0);
      const args = result.stdout.trim().split("\n");
      const env = args[args.indexOf("--set-env-vars") + 1];
      expect(env).toBeDefined();
      expect(env.slice(3).split("|")).toContain(`MATRIX_INTERNAL_CLERK_ORG_ID=${value}`);
      if (job === production) {
        expect(env.slice(3).split("|")).toContain("GOOGLE_ANALYTICS_MEASUREMENT_ID=G-SYNTHETIC123");
        expect(args[args.indexOf("--set-secrets") + 1].split(","))
          .toContain("GOOGLE_ANALYTICS_API_SECRET=google-analytics-billing-api-secret:2");
      }
    }
  });

  it("checks production candidate and promoted revision values", () => {
    expect(run(production, "Verify deployed provisioning contract")).toContain("MATRIX_INTERNAL_CLERK_ORG_ID\n");
    expect(run(production, "Verify production provisioning contract")).toContain('"MATRIX_INTERNAL_CLERK_ORG_ID=${MATRIX_INTERNAL_CLERK_ORG_ID}"');
  });

  it("rejects a production candidate that omits or substitutes the configured organization", () => {
    const values = Object.fromEntries(Object.keys(production.env).map((key) => [key, "fixture"]));
    const provisioningNames = ["CUSTOMER_VPS_IMAGE_VERSION", "MATRIX_PREBILLING_PROVISIONING_ENABLED",
      "MATRIX_PREBILLING_PROVISIONING_ROLLOUT_PERCENT", "MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE",
      "GOLDEN_SNAPSHOTS_ENABLED", "GOLDEN_SNAPSHOT_ROLLOUT_PERCENT",
      "MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID", "MATRIX_COLLABORATION_ALLOWED_ORIGINS"];
    const base = [
      ...provisioningNames.map((name) => ({ name, value: values[name] })),
      { name: "MATRIX_COLLABORATION_TICKET_KEYS", valueFrom: { secretKeyRef: { name: "collaboration-ticket-keys", key: "latest" } } },
      ...["STARTER", "BUILDER", "MAX"].map((plan) => ({ name: `STRIPE_PRICE_MATRIX_${plan}_MONTHLY`,
        valueFrom: { secretKeyRef: { name: `stripe-price-matrix-${plan.toLowerCase()}-monthly-2026-08-31`, key: "1" } } })),
    ];
    for (const value of [undefined, "org_Other", org]) {
      const env = [...base, ...(value === undefined ? [] : [{ name: "MATRIX_INTERNAL_CLERK_ORG_ID", value }])];
      const result = spawnSync("bash", ["-euc", `gcloud() { printf '%s' "$REVISION_JSON"; }\n${run(production, "Verify deployed provisioning contract")}`], {
        encoding: "utf8", timeout: 5_000, env: { PATH: process.env.PATH, ...values,
          CANDIDATE_REVISION: "synthetic-revision", MATRIX_INTERNAL_CLERK_ORG_ID: org,
          REVISION_JSON: JSON.stringify({ spec: { containers: [{ env }] } }),
        },
      });
      expect(result.status, result.stderr).toBe(value === org ? 0 : 1);
    }
  });

  it("rejects a Preview revision that drops or substitutes a configured organization", () => {
    const deployment = run(preview, "Deploy zero-traffic tagged revision to preview service");
    const end = deployment.indexOf("\nservice_base_url=");
    const base = [
      { name: "MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID", value: "collaboration-preview-v1" },
      { name: "MATRIX_COLLABORATION_ALLOWED_ORIGINS", value: "https://preview.example.test" },
      { name: "MATRIX_COLLABORATION_RELAY_ORIGIN", value: "https://preview.example.test" },
      { name: "MATRIX_COLLABORATION_TICKET_KEYS", valueFrom: { secretKeyRef: { name: "collaboration-ticket-keys-preview", key: "latest" } } },
    ];
    for (const value of [undefined, "org_Other", org]) {
      const env = [...base, ...(value === undefined ? [] : [{ name: "MATRIX_INTERNAL_CLERK_ORG_ID", value }])];
      const result = spawnSync("bash", ["-euc", `date() { printf '%s\\n' '2026-10-13T00:00:00.000Z'; }\n${deployment.slice(0, end)}\nverify_collaboration_revision <<< "$REVISION_JSON"`], {
        encoding: "utf8", timeout: 5_000, env: {
          PATH: process.env.PATH, PREVIEW_PUBLIC_URL: "https://preview.example.test",
          MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "collaboration-preview-v1",
          MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "false", MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false",
          MATRIX_INTERNAL_CLERK_ORG_ID: org, REVISION_JSON: JSON.stringify({ spec: { containers: [{ env }] } }),
        },
      });
      expect(result.status, result.stderr).toBe(value === org ? 0 : 1);
    }
  });
});
