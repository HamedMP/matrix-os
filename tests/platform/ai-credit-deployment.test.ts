import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const workflow = parse(readFileSync(".github/workflows/platform-cloud-run.yml", "utf8"));
const steps = workflow.jobs.deploy.steps as { name: string; run?: string }[];
const step = (name: string) => steps.find((entry) => entry.name === name)!.run!;
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
  MATRIX_CARD_TRIAL_DAYS: "3", MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE: "4",
  CUSTOM_MCP_ENABLED: "false", MCP_CREDENTIAL_ENCRYPTION_KEY_VERSION: "1",
  PLATFORM_SPEECH_ENABLED: "false", MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED: "false",
  MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "false", MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false",
  MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: "false", MATRIX_FUNDED_AI_RELAY_URL: "",
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
