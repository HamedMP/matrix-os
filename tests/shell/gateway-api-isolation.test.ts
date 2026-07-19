import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const gatewayCallers = [
  "shell/src/hooks/useAgentCredentialStatus.ts",
  "shell/src/hooks/useOnboarding.ts",
  "shell/src/hooks/useSetupChecklist.ts",
  "shell/src/components/onboarding/steps/AgentStep.tsx",
  "shell/src/components/onboarding/steps/GithubStep.tsx",
  "shell/src/components/onboarding/steps/RepoStep.tsx",
  "shell/src/lib/posthog-client.ts",
  "shell/src/lib/file-blob.ts",
] as const;

describe("explicit computer API isolation", () => {
  it.each(gatewayCallers)("routes gateway-owned calls through getGatewayUrl in %s", (path) => {
    const source = readFileSync(path, "utf8");

    expect(source).toContain("getGatewayUrl");
    expect(source).not.toMatch(
      /fetch\((?:"|'|`)\/api\/(?:agents|client-errors|github|onboarding|projects|workspace)/,
    );
  });
});
