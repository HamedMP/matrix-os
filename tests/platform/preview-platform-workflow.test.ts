import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("preview platform workflow", () => {
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
    expect(workflow).toContain("MATRIX_PLATFORM_SPEECH_ENABLED: ${{ vars.MATRIX_PLATFORM_SPEECH_ENABLED || 'false' }}");
    expect(workflow).toContain("MATRIX_PLATFORM_SPEECH_ORIGIN: ${{ vars.MATRIX_PLATFORM_SPEECH_ORIGIN }}");
    expect(workflow).toContain("MATRIX_PLATFORM_SPEECH_ENABLED=${MATRIX_PLATFORM_SPEECH_ENABLED}");
    expect(workflow).toContain("MATRIX_PLATFORM_SPEECH_ORIGIN=${MATRIX_PLATFORM_SPEECH_ORIGIN}");
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

  it("mounts preview-only speech secrets and activates only the dedicated host capability", () => {
    const workflow = readFileSync(join(root, ".github/workflows/preview-platform.yml"), "utf8");
    expect(workflow).toContain("PLATFORM_SPEECH_ENABLED=true");
    expect(workflow).toContain("PLATFORM_SPEECH_PROVIDER=openai");
    expect(workflow).toContain("PLATFORM_SPEECH_OPENAI_API_KEY=platform-speech-openai-api-key-preview:latest");
    expect(workflow).toContain("PLATFORM_SPEECH_SECRET=platform-speech-secret-preview:latest");
    expect(workflow).toContain("preview-speech-activation.json");
    expect(workflow).toContain("scripts/activate-speech-preview.py");
    expect(workflow).toContain("needs: connect-share-preview");
    expect(workflow).toContain("https://api.clerk.com/v1/sessions/${session_id}/tokens");
    expect(workflow).toContain("expires_in_seconds\":60");
    expect(workflow).toContain("https://app.matrix-os.com/vm/${handle}/api/terminal/run");
    const activationJob = workflow.slice(workflow.indexOf("activate-share-preview:"));
    expect(activationJob.match(/^\s*mint_session_token$/gm)).toHaveLength(3);
    expect(activationJob).toContain('"/usr/bin/systemd-run"');
    expect(activationJob).toContain('"--timer-property=AccuracySec=1s"');
    expect(activationJob).toContain("https://app.matrix-os.com/vm/${handle}/api/speech/capabilities");
    expect(activationJob).toContain('.fileTranscription.status == "ready"');
    expect(activationJob).not.toContain("--insecure");
    expect(activationJob).not.toContain("--resolve");
    expect(activationJob).not.toContain('--arg token "$PLATFORM_SECRET"');
    const activation = readFileSync(join(root, "scripts/activate-speech-preview.py"), "utf8");
    expect(activation).toContain("MATRIX_PLATFORM_SPEECH_ENABLED");
    expect(activation).toContain("MATRIX_PLATFORM_SPEECH_ORIGIN");
    expect(activation).toContain("MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN");
    expect(workflow).not.toContain("PLATFORM_INTERNAL_URL=${speech_origin}");
  });

  it("wires funded AI deployment flags without enabling an unconfigured environment", () => {
    for (const name of ["platform-cloud-run.yml", "preview-platform.yml"]) {
      const workflow = readFileSync(join(root, ".github/workflows", name), "utf8");
      expect(workflow).toContain("MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: ${{ vars.MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED || 'false' }}");
      expect(workflow).toContain("MATRIX_FUNDED_AI_RUNTIME_ENABLED: ${{ vars.MATRIX_FUNDED_AI_RUNTIME_ENABLED || 'false' }}");
      expect(workflow).toContain("MATRIX_FUNDED_AI_RELAY_URL: ${{ vars.MATRIX_FUNDED_AI_RELAY_URL }}");
      expect(workflow).toContain("${funded_ai_env_bindings}");
      expect(workflow).toContain("${funded_ai_secret_bindings}");
    }
    const production = readFileSync(join(root, ".github/workflows/platform-cloud-run.yml"), "utf8");
    expect(production).toContain("AI_RELAY_CONTROL_TOKEN=ai-relay-control-token:latest");
    expect(production).toContain("AI_FUNDED_CREDENTIAL_HASH_SECRET=ai-funded-credential-hash-secret:latest");
    const preview = readFileSync(join(root, ".github/workflows/preview-platform.yml"), "utf8");
    expect(preview).toContain("AI_RELAY_CONTROL_TOKEN=ai-relay-control-token-preview:latest");
    expect(preview).toContain("AI_FUNDED_CREDENTIAL_HASH_SECRET=ai-funded-credential-hash-secret-preview:latest");
    expect(preview).not.toMatch(/AI_RELAY_CONTROL_TOKEN=ai-relay-control-token:latest/);
    expect(preview).not.toMatch(/AI_FUNDED_CREDENTIAL_HASH_SECRET=ai-funded-credential-hash-secret:latest/);
  });
});
