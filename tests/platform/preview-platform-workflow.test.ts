import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const root = process.cwd();

describe("preview platform workflow", () => {
  it("keeps both preview connector shell steps syntactically valid", () => {
    const workflow = YAML.parse(readFileSync(join(root, ".github/workflows/preview-platform.yml"), "utf8"));
    for (const name of ["Register only the PR preview route in staging", "Enable the existing tagged host without moving traffic"]) {
      const script = workflow.jobs["connect-share-preview"].steps.find((step: { name?: string }) => step.name === name)?.run;
      expect(typeof script).toBe("string");
      const parsed = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      expect(parsed.status, parsed.stderr).toBe(0);
    }
  });
  it("sources the deployed control-plane origin from the selected environment", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/platform-cloud-run.yml"),
      "utf8",
    );

    expect(workflow).toContain("MATRIX_API_ORIGIN: ${{ vars.MATRIX_API_ORIGIN }}");
    expect(workflow).toContain("PLATFORM_PUBLIC_URL \\");
    expect(workflow).toContain("MATRIX_API_ORIGIN \\");
    expect(workflow).toContain("MATRIX_API_ORIGIN=${MATRIX_API_ORIGIN}");
    expect(workflow).not.toContain("MATRIX_API_ORIGIN=https://api.matrix-os.com");
  });

  it("bootstraps a missing Cloud Run service before deriving its dedicated API origin", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/preview-platform.yml"),
      "utf8",
    );

    expect(workflow).toContain("2>/dev/null || true");
    expect(workflow).toContain('BOOTSTRAP_API_ORIGIN="https://preview-bootstrap.invalid"');
    expect(workflow).toContain('if [ -z "$service_base_url" ]; then');
    expect(workflow).toContain('deploy_preview "$BOOTSTRAP_API_ORIGIN"');
    expect(workflow).toContain('deploy_preview "$PREVIEW_API_ORIGIN"');

    const bootstrap = workflow.indexOf('deploy_preview "$BOOTSTRAP_API_ORIGIN"');
    const deriveOrigin = workflow.indexOf(
      'PREVIEW_API_ORIGIN="https://pr-${PR_NUMBER}---${service_base_url#https://}"',
    );
    const finalDeploy = workflow.indexOf('deploy_preview "$PREVIEW_API_ORIGIN"');
    expect(bootstrap).toBeGreaterThan(-1);
    expect(deriveOrigin).toBeGreaterThan(bootstrap);
    expect(finalDeploy).toBeGreaterThan(deriveOrigin);
  });

  it("isolates managed AI and speech credentials while connecting a disposable PR runtime", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/preview-platform.yml"),
      "utf8",
    );
    const connectJob = workflow.slice(workflow.indexOf("  connect-share-preview:"));
    const connectJobHeader = connectJob.slice(0, connectJob.indexOf("    steps:"));

    expect(workflow).toContain("PLATFORM_SPEECH_ENABLED=true");
    expect(workflow).toContain("PLATFORM_SPEECH_PROVIDER=openai");
    expect(workflow).toContain("PLATFORM_SPEECH_MODEL=gpt-4o-mini-transcribe");
    expect(workflow).toContain("PLATFORM_SPEECH_OPENAI_API_KEY=platform-speech-openai-api-key-preview:latest");
    expect(workflow).toContain("PLATFORM_SPEECH_SECRET=platform-speech-secret-preview:latest");
    expect(workflow).toContain("MATRIX_PLATFORM_SPEECH_ORIGIN");
    expect(workflow).toContain("MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN");
    expect(workflow).toContain("MATRIX_PLATFORM_SPEECH_OWNER_ID");
    expect(workflow).toContain("MATRIX_PLATFORM_SPEECH_REQUEST_OWNER_ID");
    expect(workflow).toContain("MATRIX_PREVIEW_RUNTIME");
    expect(workflow).toContain("systemctl\",\"restart\",\"matrix-gateway.service");
    expect(workflow).toContain("PLATFORM_SPEECH_PREVIEW_MAX_OPERATIONS_PER_RUNTIME=25");
    expect(workflow).toContain("PLATFORM_SPEECH_PREVIEW_NOT_AFTER");
    expect(workflow).toContain("preview-runtime-route.json");
    expect(workflow).not.toContain("PREVIEW_RUNTIME_HANDOFF_PRIVATE_KEY_B64");
    expect(workflow).not.toContain("openssl pkeyutl -decrypt");
    expect(workflow).not.toContain("preview-share-runtime-access.json");
    expect(connectJobHeader).not.toContain("PREVIEW_RUNTIME_HANDOFF_PRIVATE_KEY_B64");
    expect(connectJob.indexOf("Register only the PR preview route in staging"))
      .toBeLessThan(connectJob.indexOf("Enable the existing tagged host without moving traffic"));
    expect(connectJob).toContain("access_clerk_user_ids");
    expect(connectJob).toContain("INSERT INTO user_machines");
    expect(connectJob).not.toContain("node scripts/chat-share-preview-fixture.mjs");
    expect(connectJob).toContain('PREVIEW_CLERK_USER_ID="$PREVIEW_CLERK_USER_ID"');
    expect(connectJob.indexOf("access_clerk_user_ids"))
      .toBeLessThan(connectJob.indexOf("Enable the existing tagged host without moving traffic"));
    expect(workflow).toContain("trap cleanup_preview_connection EXIT");
    expect(workflow).toContain("metadata.st_gid");
    expect(workflow).not.toContain("os.fchown(fd, 0, 0)");
    expect(workflow).not.toContain("PRODUCTION_PLATFORM_SECRET");
    expect(workflow).not.toContain("PLATFORM_SECRET: ${{ secrets.PLATFORM_SECRET }}");
    expect(workflow).toContain("systemctl\",\"is-active\",\"--quiet\",\"matrix-gateway.service");
    expect(workflow).toContain("--retry 5 --retry-all-errors --retry-delay 2 --retry-max-time 30");
    expect(connectJob).toContain('terminal_url="${PREVIEW_VPS_CONTROL_URL}/vm/${handle}/api/terminal/run"');
    expect(connectJob).toContain('PREVIEW_VPS_CONTROL_URL: https://app.matrix-os.com');
    expect(connectJob).toContain('PREVIEW_CLERK_ACCESS_USER_IDS: ${{ secrets.PREVIEW_CLERK_ACCESS_USER_IDS }}');
    expect(connectJob).toContain('MATRIX_PREVIEW_CUSTOM_MCP_ORIGIN:$origin');
    expect(connectJob).toContain('MATRIX_PREVIEW_CUSTOM_MCP_TOKEN:$mcpToken');
    expect(connectJob).toContain('MATRIX_PREVIEW_CUSTOM_MCP_OWNER_ID:$fixtureOwner');
    expect(connectJob).toContain('-H "authorization: Bearer ${preview_session_token}"');
    expect(connectJob).toContain('CLERK_SECRET_KEY: ${{ secrets.CLERK_SECRET_KEY }}');
    expect(connectJob).toContain('echo "::add-mask::$preview_session_token"');
    expect(connectJob).not.toContain("terminal_token");
    expect(connectJob).not.toContain("customer-vps.matrix-os.local");
    expect(connectJob).not.toContain("--cacert");
    expect(connectJob).not.toContain("--resolve");
    expect(connectJob).not.toContain("--insecure");
    expect(workflow).toContain("/speech/capabilities?runtimeSlot=");
    expect(workflow).toContain("/api/speech/capabilities");
    expect(workflow).toContain('os.open(path, os.O_RDONLY | os.O_NOFOLLOW)');
    expect(workflow).toContain('re.fullmatch(r"[a-f0-9]{64}", token)');
    expect(workflow).not.toContain('os.environ["MATRIX_AUTH_TOKEN"]');
    expect(workflow).toContain("EXPECTED_HEAD_SHA");
    expect(workflow).toContain("expected_image=");
    expect(workflow).toContain('--arg token "$speech_token"');
    expect(workflow).toContain("MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN:$token");
    expect(workflow).not.toContain("MATRIX_FUNDED_AI_RUNTIME_TOKEN:$token");
  });

  it("resolves the requested pull request head before selecting exact-head artifacts", () => {
    const workflow = YAML.parse(readFileSync(
      join(root, ".github/workflows/preview-platform.yml"),
      "utf8",
    ));
    const selectJob = workflow.jobs["select-share-preview"];
    const selectStep = selectJob.steps.find(
      (step: { name?: string }) => step.name === "Select exact-head preview runtime artifact",
    ).run as string;
    const pullLookup = selectStep.indexOf('gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}"');
    const artifactLookup = selectStep.indexOf("actions/workflows/preview-vps.yml/runs?head_sha=${expected_head_sha}");

    expect(selectJob.outputs.head_sha).toBe("${{ steps.runtime.outputs.head_sha }}");
    expect(pullLookup).toBeGreaterThan(-1);
    expect(artifactLookup).toBeGreaterThan(pullLookup);
    expect(selectStep).toContain('expected_head_sha="$(jq -er');
    expect(selectStep).toContain('.head.repo.full_name == $repository');
    expect(selectStep).toContain('echo "head_sha=$expected_head_sha" >> "$GITHUB_OUTPUT"');
    expect(selectStep).not.toContain("EXPECTED_HEAD_SHA");
    expect(workflow.jobs["connect-share-preview"].env.EXPECTED_HEAD_SHA)
      .toBe("${{ needs.select-share-preview.outputs.head_sha }}");
  });

  it("publishes only handle-scoped preview runtime access for the connector workflow", () => {
    const workflow = readFileSync(join(root, ".github/workflows/preview-vps.yml"), "utf8");
    const deployJob = workflow.slice(
      workflow.indexOf("  deploy:"),
      workflow.indexOf("  cleanup-expired:"),
    );

    expect(workflow).toContain("preview-runtime-route.json");
    expect(workflow).not.toContain("preview-runtime-access.enc");
    expect(workflow).not.toContain("PREVIEW_RUNTIME_HANDOFF_PUBLIC_KEY_B64");
    expect(workflow).not.toContain("openssl pkeyutl -encrypt");
    expect(workflow).not.toContain('--arg token "$runtime_token"');
    expect(workflow).not.toContain("terminalToken");
    expect(workflow).toContain("'{handle:$handle,address:$address}' > preview-runtime-route.json");
    expect(workflow).toContain("name: preview-runtime-access-");
    expect(workflow).toContain("retention-days: 1");
    expect(workflow).not.toContain("preview-runtime-cert.pem");
    expect(workflow).not.toContain("openssl s_client");
    expect(deployJob).not.toContain("environment: Preview");
  });

  it("cleans every preview speech response file on success and failure", () => {
    const workflow = YAML.parse(readFileSync(
      join(root, ".github/workflows/preview-platform.yml"),
      "utf8",
    ));
    const enableStep = workflow.jobs["connect-share-preview"].steps.find(
      (step: { name?: string }) => step.name === "Enable the existing tagged host without moving traffic",
    ).run as string;
    const cleanupTrap = enableStep.indexOf("trap cleanup_preview_connection EXIT");
    const firstResponseWrite = enableStep.indexOf('send_runtime_command "$body" "$speech_config_response"');

    expect(cleanupTrap).toBeGreaterThan(-1);
    expect(firstResponseWrite).toBeGreaterThan(cleanupTrap);
    for (const response of [
      "speech_config_response",
      "gateway_restart_response",
      "gateway_active_response",
      "speech_capabilities_response",
      "gateway_capabilities_response",
    ]) {
      expect(enableStep).toContain(`${response}=/tmp/preview-`);
      expect(enableStep).toContain(`\"$${response}\"`);
    }
  });
});
