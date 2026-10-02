import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/preview-platform.yml", "utf8");

describe("protected Slack preview connection", () => {
  it("requires the exact isolated PR revision and pilot account before connection", () => {
    expect(workflow).toContain("connect_slack_pilot:");
    expect(workflow).toContain("environment: Preview");
    expect(workflow).toContain("inputs.connect_slack_pilot");
    expect(workflow).toContain("SLACK_PILOT_PR_NUMBER");
    expect(workflow).toContain("preview-isolated");
    expect(workflow).toContain("node scripts/slack-preview-runtime.mjs verify");
    expect(workflow).toContain("clerkUserId == $owner");
    expect(workflow).toContain("node scripts/slack-preview-runtime.mjs register");
  });

  it("binds the preview VM to the exact tagged backend under the host rollback guard", () => {
    expect(workflow).toContain("PLATFORM_INTERNAL_URL:$url,UPGRADE_TOKEN:$token");
    expect(workflow).toContain("MATRIX_COLLABORATION_CLIENT_ORIGINS:$origins");
    expect(workflow).toContain('scripts/preview-collaboration-guard.py 10000 prepare "$nonce"');
    expect(workflow).toContain("--on-active=300s");
    expect(workflow).toContain("scripts/preview-collaboration-home.py 15000 apply");
    expect(workflow).toContain('"matrix-gateway.service"');
    expect(workflow).toContain("The armed guard will restore the original environment.");
    expect(workflow).toContain("MATRIX_COLLABORATION_CLIENT_ORIGINS:$origins");
    expect(workflow).toContain("PREVIEW_CLIENT_ORIGINS:");
    expect(workflow).toContain(".collaboration == true");
    expect(workflow).toContain("node scripts/preview-collaboration-staging.mjs enrollment");
    expect(workflow).not.toContain("MATRIX_SLACK_PLATFORM_URL");
  });
});
