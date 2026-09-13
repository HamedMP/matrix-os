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
    expect(workflow).toContain("preview-runtime-access");
    expect(workflow).toContain("metadata.st_gid");
    expect(workflow).not.toContain("os.fchown(fd, 0, 0)");
    expect(workflow).not.toContain("PRODUCTION_PLATFORM_SECRET");
    expect(workflow).not.toContain("PLATFORM_SECRET: ${{ secrets.PLATFORM_SECRET }}");
    expect(workflow).toContain("systemctl\",\"is-active\",\"--quiet\",\"matrix-gateway.service");
    expect(workflow).toContain("/speech/capabilities?runtimeSlot=");
  });

  it("publishes only handle-scoped preview runtime access for the connector workflow", () => {
    const workflow = readFileSync(join(root, ".github/workflows/preview-vps.yml"), "utf8");

    expect(workflow).toContain("preview-runtime-access.json");
    expect(workflow).toContain("terminalToken");
    expect(workflow).toContain("name: preview-runtime-access-");
    expect(workflow).toContain("retention-days: 1");
  });
});
