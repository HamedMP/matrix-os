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

  it("bakes the preview Clerk key and app origin into the Next auth shell", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/preview-platform.yml"),
      "utf8",
    );

    expect(workflow).toContain(
      'next_public_clerk_publishable_key="$(gcloud secrets versions access latest --secret next-public-clerk-publishable-key',
    );
    expect(workflow).toContain(
      "next-public-clerk-publishable-key is required to build the preview auth shell.",
    );
    expect(workflow).toContain(
      '_NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$next_public_clerk_publishable_key',
    );
    expect(workflow).toContain('_NEXT_PUBLIC_MATRIX_APP_URL=$preview_public_url');
  });

  it("accepts the Cloud Run service host used by the preview Cloudflare origin", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/preview-platform.yml"),
      "utf8",
    );

    expect(workflow).toContain('local app_domain_hosts="$2"');
    expect(workflow).toContain('MATRIX_APP_DOMAIN_HOSTS=${app_domain_hosts}');
    expect(workflow).toContain('PREVIEW_SERVICE_DOMAIN="${service_base_url#https://}"');
    expect(workflow).toContain('deploy_preview "$PREVIEW_API_ORIGIN" "$PREVIEW_SERVICE_DOMAIN"');
  });
});
