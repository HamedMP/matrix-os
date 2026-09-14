import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("Agent SDK compatibility CI gate", () => {
  it("installs the exact external SDK and includes the real-runtime spike in CI Results", () => {
    const workflow = parse(
      readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8"),
    ) as {
      jobs: Record<string, {
        name?: string;
        needs?: string[];
        steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
      }>;
    };

    const compatibility = workflow.jobs["agent-sdk-compatibility"];
    expect(
      ((workflow as unknown as { on: { pull_request: { branches: string[] } } }).on
        .pull_request.branches),
    ).toContain("codex/**");
    expect(compatibility?.name).toBe("Agent SDK 0.3.251 Compatibility");
    const installStep = compatibility?.steps?.find(
      (step) => step.name === "Install exact Agent SDK",
    )?.run;
    expect(installStep).toContain(
      'mkdir -p "${{ runner.temp }}/matrix-agent-sdk-03251"',
    );
    expect(installStep).toContain("@anthropic-ai/claude-agent-sdk@0.3.251");

    const runtimeStep = compatibility?.steps?.find(
      (step) => step.name === "Run real Agent SDK compatibility spike",
    );
    expect(runtimeStep?.env?.MATRIX_AGENT_SDK_PACKAGE_DIR).toContain(
      "node_modules/@anthropic-ai/claude-agent-sdk",
    );
    expect(runtimeStep?.run).toContain(
      "tests/scripts/agent-sdk-real-runtime-spike.test.ts",
    );

    const aggregate = workflow.jobs["ci-results"];
    expect(aggregate?.needs).toContain("agent-sdk-compatibility");
    expect(
      aggregate?.steps?.find((step) => step.name === "Summarize required CI jobs")
        ?.env?.AGENT_SDK_COMPATIBILITY_RESULT,
    ).toBe("${{ needs.agent-sdk-compatibility.result }}");
  });
});
