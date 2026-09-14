import { describe, expect, it } from "vitest";

import { runFakeProviderVerification } from "../../scripts/spikes/agent-sdk-gateway/fake-provider.mjs";

const sdkPackageDirectory = process.env.MATRIX_AGENT_SDK_PACKAGE_DIR;

describe.skipIf(!sdkPackageDirectory)("Agent SDK 0.3.251 real-runtime spike", () => {
  it(
    "proves transport auth, first-turn in-process MCP, PreToolUse, skills, resume, and usage",
    async () => {
      const report = await runFakeProviderVerification({
        sdkPackageDirectory: sdkPackageDirectory!,
      });

      expect(report).toMatchObject({
        sdkVersion: "0.3.251",
        transport: {
          authorization: "present",
          baseUrl: "loopback",
          messagesPath: "/v1/messages?beta=true",
        },
        firstTurn: {
          hookCalls: 1,
          mcpCalls: 1,
          result: "mcp-ok",
          skillLoaded: true,
          usageModel: "claude-haiku-4-5",
        },
        resume: {
          result: "resume-ok",
          reusedSession: true,
        },
        cancellation: {
          aborted: true,
          withinDeadline: true,
        },
        subagent: {
          result: "subagent-ok",
          spawned: 1,
        },
        refusal: {
          structuredEvent: "model_refusal_no_fallback",
          stopReason: "refusal",
        },
      });
      expect(report.transport.anthropicBeta).toContain("claude-code-20250219");
      expect(report.transport.authorization).not.toContain("spike-token");
    },
    30_000,
  );
});
