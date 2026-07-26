import { describe, expect, it, vi } from "vitest";
import {
  buildSupervisedAgentLaunch,
  SupervisedAgentConfigurationSchema,
} from "../../packages/gateway/src/coding-agents/supervised-launch.js";
import { createSupervisedZellijRuntime } from "../../packages/gateway/src/supervised-zellij-runtime.js";

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

  it("publishes one configuration before CreateStart and removes it on rejection", async () => {
    const configuration = buildSupervisedAgentLaunch({
      operationId: OPERATION_ID,
      agent: "claude",
      cwd: "/home/matrix/home/projects/private",
      prompt: "private prompt",
      sandbox: { enabled: true, mode: "workspace-write" },
    });
    const configurations = {
      publish: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const runtime = {
      list: vi.fn(async () => []),
      inspect: vi.fn(),
      createShell: vi.fn(),
      createAgent: vi.fn(async () => {
        throw new Error("supervisor rejected");
      }),
      rename: vi.fn(),
      delete: vi.fn(),
    };
    const zellij = { sendInput: vi.fn() };
    const supervised = createSupervisedZellijRuntime({
      homePath: "/home/matrix/home",
      runtime: runtime as never,
      zellij: zellij as never,
      configurations,
    });

    await expect(supervised.start({
      sessionId: "sess-private",
      launch: {
        command: configuration.matrixArgv[0],
        args: [configuration.matrixArgv[1]],
        cwd: "/home/matrix/home/projects/private",
        env: {},
        supervised: {
          configurationRef: OPERATION_ID,
          configuration: configuration.configuration,
        },
      },
    })).rejects.toThrow("supervisor rejected");

    expect(configurations.publish).toHaveBeenCalledWith(
      OPERATION_ID,
      configuration.configuration,
    );
    expect(runtime.createAgent).toHaveBeenCalledWith({
      displayName: "sess-private",
      cwd: "/home/matrix/home/projects/private",
      configurationRef: OPERATION_ID,
    });
    expect(configurations.remove).toHaveBeenCalledWith(OPERATION_ID);
  });
});
