import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectTenantPublicTelemetryEnv } from "../../packages/platform/src/platform-startup-env";

describe("Support identity server secret configuration", () => {
  it("documents a server-only secret and never copies it into tenant telemetry env", () => {
    const root = process.cwd();
    const example = readFileSync(join(root, ".env.example"), "utf8");
    expect(example).toContain("POSTHOG_CONVERSATIONS_IDENTITY_SECRET=");
    expect(example.toLowerCase()).toContain("server-only");

    const publicEnv = collectTenantPublicTelemetryEnv({
      POSTHOG_TOKEN: "phc_public",
      POSTHOG_CONVERSATIONS_IDENTITY_SECRET: "must-stay-server-only",
    });
    expect(publicEnv).toEqual(["POSTHOG_TOKEN=phc_public"]);
    expect(publicEnv.join("\n")).not.toContain("must-stay-server-only");
  });

  it("binds the secret only to the platform Cloud Run service", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows/platform-cloud-run.yml"),
      "utf8",
    );
    expect(workflow).toContain(
      "POSTHOG_CONVERSATIONS_IDENTITY_SECRET=posthog-conversations-identity-secret:latest",
    );
  });
});
