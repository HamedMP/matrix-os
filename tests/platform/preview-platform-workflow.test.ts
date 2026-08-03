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

  it("recognizes the isolated Cloud Run service host behind the preview domain", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/preview-platform.yml"),
      "utf8",
    );

    expect(workflow).toContain('local session_hosts="$2"');
    expect(workflow).toContain(
      'PREVIEW_SERVICE_DOMAIN="${service_base_url#https://}"',
    );
    expect(workflow).toContain(
      'PREVIEW_SESSION_HOSTS="${PREVIEW_SERVICE_DOMAIN}"',
    );
    expect(workflow).toContain(
      "MATRIX_APP_DOMAIN_HOSTS=${session_hosts}",
    );
    expect(workflow).toContain(
      'deploy_preview "$PREVIEW_API_ORIGIN" "$PREVIEW_SESSION_HOSTS"',
    );
  });

  it("passes only the selected disposable VPS route into the isolated preview", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/preview-platform.yml"),
      "utf8",
    );

    expect(workflow).toContain(
      "PRODUCTION_PLATFORM_SECRET: ${{ secrets.PLATFORM_SECRET }}",
    );
    expect(workflow).toContain('curl --fail --silent --show-error --max-time 10');
    expect(workflow).toContain('select(.handle == $h and .runtimeSlot == $h');
    expect(workflow).toContain("PLATFORM_PREVIEW_ROUTE_MACHINE_ID=${preview_machine_id}");
    expect(workflow).toContain("PLATFORM_PREVIEW_ROUTE_HANDLE=${preview_handle}");
    expect(workflow).toContain("PLATFORM_PREVIEW_ROUTE_IPV4=${preview_ipv4}");
    expect(workflow).not.toContain("PLATFORM_DATABASE_URL=platform-database-url:latest");
  });
});
