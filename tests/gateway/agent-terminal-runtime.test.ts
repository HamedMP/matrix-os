import { describe, expect, it } from "vitest";
import {
  buildSupervisedAgentLaunch,
  SupervisedAgentConfigurationSchema,
} from "../../packages/gateway/src/coding-agents/supervised-launch.js";

const OPERATION_ID = "abcdef0123456789abcdef0123456789";

describe("supervised coding-agent launch", () => {
  it.each(["claude", "codex", "opencode", "pi"] as const)(
    "keeps %s prompt, cwd, credentials, and dynamic options out of Matrix-managed argv",
    (agent) => {
      const prompt = "fix the secret regression";
      const cwd = "/home/matrix/home/projects/private";
      const launch = buildSupervisedAgentLaunch({
        operationId: OPERATION_ID,
        agent,
        cwd,
        prompt,
        mode: "plan",
        approvalPolicy: "on-request",
        sandbox: {
          enabled: true,
          mode: "workspace-write",
          writableRoots: [cwd],
          denyWriteRoots: ["/home/matrix/home/system"],
        },
      });

      expect(launch.descriptor).toEqual({
        kind: "agent",
        configurationRef: OPERATION_ID,
      });
      expect(launch.matrixArgv).toEqual([
        "/opt/matrix/bin/matrix-terminal-pane",
        "agent",
      ]);
      expect(JSON.stringify(launch.matrixArgv)).not.toContain(prompt);
      expect(JSON.stringify(launch.matrixArgv)).not.toContain(cwd);
      expect(JSON.stringify(launch.matrixArgv)).not.toContain(agent);
      expect(JSON.stringify(launch.matrixArgv)).not.toContain("on-request");
      expect(SupervisedAgentConfigurationSchema.parse(launch.configuration)).toMatchObject({
        schemaVersion: 1,
        agent,
        cwd: { kind: "home-relative", path: "projects/private" },
        prompt,
        mode: "plan",
        approvalPolicy: "on-request",
      });
    },
  );

  it("rejects absolute or traversal configuration cwd values", () => {
    const input = {
      schemaVersion: 1,
      agent: "codex",
      cwd: { kind: "home-relative", path: "../private" },
      prompt: "safe prompt",
      mode: "default",
      approvalPolicy: "never",
      sandbox: {
        enabled: true,
        mode: "workspace-write",
        writableRoots: [],
        denyWriteRoots: [],
      },
    };
    expect(SupervisedAgentConfigurationSchema.safeParse(input).success).toBe(false);
  });
});
