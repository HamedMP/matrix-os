import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflowPath = new URL("../../.github/workflows/preview-chat-candidate-edge.yml", import.meta.url);

describe("one-chat Platform candidate Edge deployment", () => {
  it("probes only read access to the bounded funded Preview gateway without exposing its settings", () => {
    const source = readFileSync(workflowPath, "utf8");
    expect(source).toContain("Cloudflare AI Gateway read permission probe");
    expect(source).toContain("--request GET");
    expect(source).toContain("/ai-gateway/gateways/matrix-funded-preview");
    expect(source).toContain(".success == true and .result.id == \"matrix-funded-preview\"");
    expect(source).toContain("readable=${readable}");
    expect(source).not.toMatch(/--request (?:PUT|POST|PATCH|DELETE).*ai-gateway/);
    expect(source.indexOf("# Cloudflare AI Gateway read permission probe.")).toBeGreaterThan(
      source.indexOf('Candidate selector does not approve this exact head'),
    );
    expect(source.indexOf("# Cloudflare AI Gateway read permission probe.")).toBeGreaterThan(
      source.lastIndexOf('gh api "repos/${GITHUB_REPOSITORY}/pulls/2045"'),
    );
  });

  it("requires a deliberate same-repository PR label and an approved exact head before Production secrets", () => {
    const source = readFileSync(workflowPath, "utf8");
    expect(source).toContain("pull_request:");
    expect(source).toContain("types: [labeled]");
    expect(source).not.toContain("pull_request_target:");
    expect(source).not.toContain("workflow_dispatch:");
    expect(source).toContain("preview-chat-candidate-route");
    expect(source).toContain("github.event.pull_request.number == 2045");
    expect(source).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(source).toContain("ref: ${{ github.event.pull_request.head.sha }}");
    expect(source).toContain("environment: Production");
    expect(source).toContain("needs: test");
    expect(source).toContain("gcloud secrets versions access latest");
    expect(source).toContain('--out-file="$raw_selector" --quiet');
    expect(source).toContain("approvedHeadSha");
    expect(source).toContain('gh api "repos/${GITHUB_REPOSITORY}/pulls/2045"');
    expect(source).toContain("--secrets-file");
    expect(source).toContain("x-matrix-preview-platform-route: candidate");
    expect(source).toContain('status_code="$(curl');
    expect(source).toContain('if [ "$status_code" != "401" ] && [ "$status_code" != "403" ] && [ "$unauth_login" != true ]; then');
    expect(source).toContain('"$status_code" = "200"');
    expect(source).toContain('^content-type: text/html');
    expect(source).toContain('Sign in to continue to your Matrix computer');
    expect(source).toContain("trap cleanup EXIT");
    expect(source).not.toMatch(/echo\s+.*(?:CLOUDFLARE_API_TOKEN|chatId|candidateOrigin)/);
  });
});
