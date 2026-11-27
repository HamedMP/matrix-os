import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

// User outcome: an operator can turn the metal substrate and free tier on for exactly one
// preview PR (the staging end-to-end test) without changing any other PR's preview revision.
// Faults detected: metal settings leaking into other PRs' deploys, secrets passed as plain
// env vars, and an unvalidated golden version reaching hostd's create contract.
const job = YAML.parse(readFileSync(".github/workflows/preview-platform.yml", "utf8")).jobs.preview;
const validation: string = job.steps.find((step: { name?: string }) => step.name === "Check preview configuration").run;
const deployment: string = job.steps.find(
  (step: { name?: string }) => step.name === "Deploy zero-traffic tagged revision to preview service",
).run;

const PR = "2691";
const METAL_SECRETS = [
  "METAL_HOSTD_API_TOKEN=metal-hostd-api-token-preview:latest",
  "METAL_HOSTD_INGRESS_TOKEN=metal-hostd-ingress-token-preview:latest",
  "METAL_HOSTD_CA_PEM=metal-hostd-ca-pem-preview:latest",
];
const METAL_ON = {
  PREVIEW_METAL_ENABLED: "1",
  PREVIEW_METAL_PR_NUMBER: PR,
  PREVIEW_METAL_GOLDEN_VERSION: "golden-2026.11.20_1",
  PREVIEW_FREE_TIER_MAX_RUNTIMES: "10",
  PREVIEW_FREE_TIER_INVITE_REQUIRED: "true",
  PREVIEW_FREE_TIER_SLEEP_ENABLED: "1",
  PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: "20000000",
};

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    PATH: process.env.PATH,
    GITHUB_OUTPUT: "/dev/null",
    CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform-preview",
    CLOUD_RUN_SERVICE_ACCOUNT: "synthetic-preview-runner",
    MATRIX_CARD_TRIALS_ENABLED: "false", MATRIX_CARD_TRIAL_DAYS: "3", MATRIX_STARTER_TRIAL_DAYS: "14",
    MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: "false",
    MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false",
    MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "collaboration-preview-v1",
    PR_NUMBER: PR,
    ...overrides,
  };
}

function validate(overrides: Record<string, string | undefined>) {
  return spawnSync("bash", ["-euc", validation], { env: environment(overrides), encoding: "utf8", timeout: 5_000 });
}

function deployedArguments(overrides: Record<string, string | undefined>): string[] {
  const directory = mkdtempSync(join(tmpdir(), "preview-metal-"));
  const capture = join(directory, "arguments");
  try {
    // Runs the workflow's real setup + deploy function; the gcloud stub only records argv.
    const functionEnd = deployment.indexOf("\nservice_base_url=");
    expect(functionEnd).toBeGreaterThan(0);
    const script = `gcloud() { printf '%s\\0' "$@" > "$CAPTURE"; }\ndate() { printf '%s\\n' '2026-11-21T00:00:00.000Z'; }\n${deployment.slice(0, functionEnd)}\ndeploy_preview https://synthetic-preview.example.test`;
    const result = spawnSync("bash", ["-euc", script], { encoding: "utf8", timeout: 5_000, env: {
      ...environment(overrides), CAPTURE: capture, CUSTOM_MCP_ENABLED: "false",
      GCP_PROJECT_ID: "synthetic-project", GCP_REGION: "synthetic-region",
      IMAGE: "synthetic-image:603751f4885c", PREVIEW_PUBLIC_URL: "https://preview.example.test",
    } });
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(capture, "utf8").split("\0");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const envBindings = (args: string[]) => flagValue(args, "--set-env-vars").replace(/^\^\|\^/, "").split("|");
const secretBindings = (args: string[]) => flagValue(args, "--set-secrets").split(",");

describe("preview platform metal substrate and free tier switch", () => {
  it("sources the switch from Preview environment variables, off by default", () => {
    expect(job.environment).toBe("Preview");
    expect(job.env.PREVIEW_METAL_ENABLED).toBe("${{ vars.PREVIEW_METAL_ENABLED || '0' }}");
    expect(job.env.PREVIEW_METAL_PR_NUMBER).toBe("${{ vars.PREVIEW_METAL_PR_NUMBER }}");
    expect(job.env.PREVIEW_METAL_GOLDEN_VERSION).toBe("${{ vars.PREVIEW_METAL_GOLDEN_VERSION }}");
    expect(job.env.PREVIEW_FREE_TIER_MAX_RUNTIMES).toBe("${{ vars.PREVIEW_FREE_TIER_MAX_RUNTIMES || '10' }}");
    expect(job.env.PREVIEW_FREE_TIER_INVITE_REQUIRED).toBe("${{ vars.PREVIEW_FREE_TIER_INVITE_REQUIRED || 'true' }}");
    expect(job.env.PREVIEW_FREE_TIER_SLEEP_ENABLED).toBe("${{ vars.PREVIEW_FREE_TIER_SLEEP_ENABLED || '1' }}");
    expect(job.env.PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD).toBe(
      "${{ vars.PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD || '20000000' }}",
    );
  });

  it("leaves the deploy command unchanged when the switch is off or targets another PR", () => {
    const baseline = deployedArguments({});
    const joined = baseline.join("\n");
    expect(joined).not.toMatch(/METAL_|FREE_TIER/);
    expect(deployedArguments({ ...METAL_ON, PREVIEW_METAL_ENABLED: "0" })).toEqual(baseline);
    expect(deployedArguments({ ...METAL_ON, PREVIEW_METAL_PR_NUMBER: "1947" })).toEqual(baseline);
    expect(deployedArguments({ ...METAL_ON, PREVIEW_METAL_PR_NUMBER: "" })).toEqual(baseline);
    expect(validate({}).status).toBe(0);
    expect(validate({ ...METAL_ON, PREVIEW_METAL_ENABLED: "0", PREVIEW_METAL_GOLDEN_VERSION: "" }).status).toBe(0);
  });

  it("adds the metal and free tier settings plus the three hostd secrets for the selected PR", () => {
    const checked = validate(METAL_ON);
    expect(checked.status, checked.stderr).toBe(0);
    const baseline = deployedArguments({});
    const args = deployedArguments(METAL_ON);
    const env = envBindings(args);
    expect(env).toEqual(expect.arrayContaining([
      "METAL_HOSTS_ENABLED=1",
      "METAL_GOLDEN_VERSION=golden-2026.11.20_1",
      "MATRIX_FREE_TIER_ENABLED=1",
      "MATRIX_FREE_TIER_MAX_RUNTIMES=10",
      "MATRIX_FREE_TIER_INVITE_REQUIRED=true",
      "MATRIX_FREE_TIER_SLEEP_ENABLED=1",
      "MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD=20000000",
    ]));
    expect(secretBindings(args)).toEqual(expect.arrayContaining(METAL_SECRETS));
    // Only additions: every baseline binding and flag is preserved.
    expect(env).toEqual(expect.arrayContaining(envBindings(baseline)));
    expect(secretBindings(args)).toEqual(expect.arrayContaining(secretBindings(baseline)));
    const withoutBindingValues = (list: string[]) => list.filter((_, index) =>
      list[index - 1] !== "--set-env-vars" && list[index - 1] !== "--set-secrets");
    expect(withoutBindingValues(args)).toEqual(withoutBindingValues(baseline));
    expect(envBindings(args)).toHaveLength(envBindings(baseline).length + 7);
    expect(secretBindings(args)).toHaveLength(secretBindings(baseline).length + 3);
    // No hostd credential ever travels as a plain env var.
    expect(env.some((binding) => /^METAL_HOSTD_/.test(binding))).toBe(false);
    expect(flagValue(args, "--set-env-vars")).not.toMatch(/-preview:latest/);
  });

  it("forwards an explicit open signup and runtime ceiling", () => {
    const overrides = { ...METAL_ON, PREVIEW_FREE_TIER_MAX_RUNTIMES: "250", PREVIEW_FREE_TIER_INVITE_REQUIRED: "false" };
    expect(validate(overrides).status).toBe(0);
    const env = envBindings(deployedArguments(overrides));
    expect(env).toContain("MATRIX_FREE_TIER_MAX_RUNTIMES=250");
    expect(env).toContain("MATRIX_FREE_TIER_INVITE_REQUIRED=false");
  });

  it("forwards disabled sleep and an explicit daily funded spend ceiling", () => {
    const overrides = { ...METAL_ON, PREVIEW_FREE_TIER_SLEEP_ENABLED: "0", PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: "5000000" };
    expect(validate(overrides).status).toBe(0);
    const env = envBindings(deployedArguments(overrides));
    expect(env).toContain("MATRIX_FREE_TIER_SLEEP_ENABLED=0");
    expect(env).toContain("MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD=5000000");
  });

  it.each([
    ["", "golden version"], ["-leading-dash", "golden version"], [".hidden", "golden version"],
    ["a".repeat(65), "golden version"], ["v1;rm -rf", "golden version"], ["v1|METAL_HOSTS_ENABLED=0", "golden version"],
    ["v 1", "golden version"],
  ])("rejects golden version %j before deployment", (golden) => {
    const result = validate({ ...METAL_ON, PREVIEW_METAL_GOLDEN_VERSION: golden });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/PREVIEW_METAL_GOLDEN_VERSION/);
  });

  it.each([
    { PREVIEW_METAL_GOLDEN_VERSION: "v1|METAL_HOSTS_ENABLED=0" },
    { PREVIEW_FREE_TIER_SLEEP_ENABLED: "1|METAL_HOSTS_ENABLED=0" },
    { PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: "1|METAL_HOSTS_ENABLED=0" },
  ])("refuses an injected setting %j even if validation was bypassed", (bad) => {
    const directory = mkdtempSync(join(tmpdir(), "preview-metal-"));
    try {
      const functionEnd = deployment.indexOf("\nservice_base_url=");
      const script = `gcloud() { :; }\n${deployment.slice(0, functionEnd)}\ndeploy_preview https://synthetic-preview.example.test`;
      const result = spawnSync("bash", ["-euc", script], { encoding: "utf8", timeout: 5_000, env: {
        ...environment({ ...METAL_ON, ...bad }),
        CUSTOM_MCP_ENABLED: "false", GCP_PROJECT_ID: "p", GCP_REGION: "r", IMAGE: "i", PREVIEW_PUBLIC_URL: "https://preview.example.test",
      } });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("refusing to deploy");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each([
    [{ PREVIEW_METAL_ENABLED: "yes" }, "PREVIEW_METAL_ENABLED"],
    [{ PREVIEW_METAL_ENABLED: "true" }, "PREVIEW_METAL_ENABLED"],
    [{ PREVIEW_METAL_PR_NUMBER: "abc" }, "PREVIEW_METAL_PR_NUMBER"],
    [{ PREVIEW_METAL_PR_NUMBER: "" }, "PREVIEW_METAL_PR_NUMBER"],
    [{ PREVIEW_FREE_TIER_MAX_RUNTIMES: "0" }, "PREVIEW_FREE_TIER_MAX_RUNTIMES"],
    [{ PREVIEW_FREE_TIER_MAX_RUNTIMES: "10000" }, "PREVIEW_FREE_TIER_MAX_RUNTIMES"],
    [{ PREVIEW_FREE_TIER_MAX_RUNTIMES: "1|X=1" }, "PREVIEW_FREE_TIER_MAX_RUNTIMES"],
    [{ PREVIEW_FREE_TIER_INVITE_REQUIRED: "no" }, "PREVIEW_FREE_TIER_INVITE_REQUIRED"],
    [{ PREVIEW_FREE_TIER_SLEEP_ENABLED: "true" }, "PREVIEW_FREE_TIER_SLEEP_ENABLED"],
    [{ PREVIEW_FREE_TIER_SLEEP_ENABLED: "" }, "PREVIEW_FREE_TIER_SLEEP_ENABLED"],
    [{ PREVIEW_FREE_TIER_SLEEP_ENABLED: "1|X=1" }, "PREVIEW_FREE_TIER_SLEEP_ENABLED"],
    [{ PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: "0" }, "PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD"],
    [{ PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: "020000000" }, "PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD"],
    [{ PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: "1".repeat(13) }, "PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD"],
    [{ PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: "-1" }, "PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD"],
    [{ PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: "" }, "PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD"],
    [{ PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: "1|X=1" }, "PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD"],
  ])("rejects invalid switch settings %j", (overrides, name) => {
    const result = validate({ ...METAL_ON, ...overrides });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
  });

  it("does not validate free tier inputs for PRs the switch does not target", () => {
    const result = validate({ ...METAL_ON, PREVIEW_METAL_PR_NUMBER: "1947", PREVIEW_METAL_GOLDEN_VERSION: "" });
    expect(result.status, result.stderr).toBe(0);
  });
});

// The share-preview connector redeploys a PR's tag with --update-* flags, which merge onto the
// service template (the most recently deployed revision). It must converge to the same metal state
// as the main deploy: strip inherited metal settings from other PRs, re-apply them for the selected PR.
const connectJob = YAML.parse(readFileSync(".github/workflows/preview-platform.yml", "utf8")).jobs["connect-share-preview"];
const connectStep: string = connectJob.steps.find(
  (step: { name?: string }) => step.name === "Enable the existing tagged host without moving traffic",
).run;
const connectScript = connectStep.split('if ! [[ "$PREVIEW_CLERK_USER_ID"')[0];
const METAL_ENV_NAMES = "METAL_HOSTS_ENABLED,METAL_GOLDEN_VERSION,MATRIX_FREE_TIER_ENABLED,MATRIX_FREE_TIER_MAX_RUNTIMES,MATRIX_FREE_TIER_INVITE_REQUIRED,MATRIX_FREE_TIER_SLEEP_ENABLED,MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD";
const METAL_SECRET_NAMES = "METAL_HOSTD_API_TOKEN,METAL_HOSTD_INGRESS_TOKEN,METAL_HOSTD_CA_PEM";

function connectorArguments(overrides: Record<string, string | undefined>) {
  const result = spawnSync("bash", ["-c", `
    gcloud() {
      case "$1 $2 $3" in
        "help "*) return 0 ;;
        "run services describe") printf '%s' '{"status":{"url":"https://service.run.app","traffic":[{"tag":"pr-${PR}","revisionName":"revision-${PR}","url":"https://pr-${PR}---service.run.app"}]}}' ;;
        "run revisions describe") printf '%s' "$FIXTURE_REVISION" ;;
        "artifacts docker images") printf '%s' 'sha256:fixture' ;;
        "run deploy matrix-platform-preview") printf '%s\\0' "$@" ;;
        *) return 1 ;;
      esac
    }
    ${connectScript}
  `], { encoding: "utf8", timeout: 5_000, env: {
    PATH: process.env.PATH, PR_NUMBER: PR, GCP_PROJECT_ID: "fixture", GCP_REGION: "region",
    ARTIFACT_REPOSITORY: "images", CLOUD_RUN_PREVIEW_SERVICE: "matrix-platform-preview",
    EXPECTED_HEAD_SHA: "a".repeat(40), CUSTOM_MCP_ENABLED: "false",
    FIXTURE_REVISION: JSON.stringify({ spec: { containers: [{
      image: `region-docker.pkg.dev/fixture/images/matrix-platform:pr-${PR}-aaaaaaaaaaaa`,
      env: [{ name: "MATRIX_APP_ORIGIN", value: "https://preview.example.com" }],
    }] } }),
    ...overrides,
  } });
  return { result, args: result.stdout.split("\0").filter(Boolean) };
}

describe("share-preview connector converges to the metal switch", () => {
  it("reads the same Preview switch variables as the main deploy", () => {
    expect(connectJob.environment).toBe("Preview");
    for (const name of ["PREVIEW_METAL_ENABLED", "PREVIEW_METAL_PR_NUMBER", "PREVIEW_METAL_GOLDEN_VERSION",
      "PREVIEW_FREE_TIER_MAX_RUNTIMES", "PREVIEW_FREE_TIER_INVITE_REQUIRED",
      "PREVIEW_FREE_TIER_SLEEP_ENABLED", "PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD"]) {
      expect(connectJob.env[name]).toBe(job.env[name]);
    }
  });

  it.each([
    ["switch off", { ...METAL_ON, PREVIEW_METAL_ENABLED: "0" }],
    ["switch unset", {}],
    ["another PR selected", { ...METAL_ON, PREVIEW_METAL_PR_NUMBER: "1947" }],
  ])("removes inherited metal settings when %s", (_label, overrides) => {
    const { result, args } = connectorArguments(overrides);
    expect(result.status, result.stderr).toBe(0);
    expect(flagValue(args, "--remove-env-vars")).toBe(METAL_ENV_NAMES);
    expect(flagValue(args, "--remove-secrets")).toBe(METAL_SECRET_NAMES);
    expect(flagValue(args, "--update-env-vars")).not.toMatch(/METAL_|FREE_TIER/);
    expect(args).not.toContain("--update-secrets");
  });

  it("keeps the custom MCP secret update alongside the metal removal", () => {
    const { result, args } = connectorArguments({ CUSTOM_MCP_ENABLED: "true" });
    expect(result.status, result.stderr).toBe(0);
    expect(flagValue(args, "--update-secrets")).toBe("MCP_CREDENTIAL_ENCRYPTION_KEY=mcp-credential-encryption-key-preview:1");
    expect(flagValue(args, "--remove-secrets")).toBe(METAL_SECRET_NAMES);
  });

  it.each(["false", "true"])("re-applies the validated metal settings for the selected PR (custom MCP %s)", (customMcp) => {
    const { result, args } = connectorArguments({ ...METAL_ON, CUSTOM_MCP_ENABLED: customMcp });
    expect(result.status, result.stderr).toBe(0);
    const env = flagValue(args, "--update-env-vars").replace(/^\^@\^/, "").split("@");
    expect(env).toEqual(expect.arrayContaining([
      "METAL_HOSTS_ENABLED=1", "METAL_GOLDEN_VERSION=golden-2026.11.20_1", "MATRIX_FREE_TIER_ENABLED=1",
      "MATRIX_FREE_TIER_MAX_RUNTIMES=10", "MATRIX_FREE_TIER_INVITE_REQUIRED=true",
      "MATRIX_FREE_TIER_SLEEP_ENABLED=1", "MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD=20000000",
    ]));
    expect(env.some((binding) => /^METAL_HOSTD_/.test(binding))).toBe(false);
    const secrets = flagValue(args, "--update-secrets").split(",");
    expect(secrets).toEqual(expect.arrayContaining(METAL_SECRETS));
    if (customMcp === "true") expect(secrets).toContain("MCP_CREDENTIAL_ENCRYPTION_KEY=mcp-credential-encryption-key-preview:1");
    expect(args.filter((arg) => arg === "--update-secrets")).toHaveLength(1);
    expect(args.filter((arg) => arg === "--update-env-vars")).toHaveLength(1);
    expect(args).not.toContain("--remove-env-vars");
    expect(args).not.toContain("--remove-secrets");
  });

  it.each([
    { PREVIEW_METAL_GOLDEN_VERSION: "v1@METAL_HOSTS_ENABLED=0" },
    { PREVIEW_METAL_GOLDEN_VERSION: "" },
    { PREVIEW_FREE_TIER_MAX_RUNTIMES: "0" },
    { PREVIEW_FREE_TIER_INVITE_REQUIRED: "no" },
    { PREVIEW_FREE_TIER_SLEEP_ENABLED: "2" },
    { PREVIEW_FREE_TIER_SLEEP_ENABLED: "1@METAL_HOSTS_ENABLED=0" },
    { PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: "0" },
    { PREVIEW_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD: "1@METAL_HOSTS_ENABLED=0" },
    { PREVIEW_METAL_ENABLED: "yes" },
    { PREVIEW_METAL_PR_NUMBER: "abc" },
  ])("refuses to redeploy with invalid metal settings %j", (bad) => {
    const { result, args } = connectorArguments({ ...METAL_ON, ...bad });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to deploy");
    expect(args).not.toContain("--update-env-vars");
  });
});
