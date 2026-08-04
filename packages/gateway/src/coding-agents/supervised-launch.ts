import { relative, resolve, sep } from "node:path";
import {
  AgentConfigurationSchema,
  HomeRelativeCwdSchema,
  OperationIdSchema,
  type AgentConfiguration,
} from "@matrix-os/terminal-runtime";
import { CODEX_VERIFIED_VERSION } from "@matrix-os/contracts";

export const SupervisedAgentConfigurationSchema = AgentConfigurationSchema;
export type SupervisedAgentConfiguration = AgentConfiguration;

function relativeOwnerPath(homePath: string, path: string) {
  const root = resolve(homePath);
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error("terminal_agent_path_invalid");
  }
  return HomeRelativeCwdSchema.parse({
    kind: "home-relative",
    path: relative(root, target).split(sep).join("/"),
  });
}

export function buildSupervisedAgentLaunch(input: {
  operationId: string;
  agent: "claude" | "codex" | "opencode" | "pi";
  cwd: string;
  prompt?: string;
  mode?: "default" | "plan" | "review" | "full_access";
  approvalPolicy?: "untrusted" | "on-request" | "on-failure" | "never";
  codexExecutable?: string;
  providerEventPath?: string;
  sandbox: {
    enabled: boolean;
    mode?: "read-only" | "workspace-write" | "danger-full-access";
    writableRoots?: string[];
    denyWriteRoots?: string[];
    adminOverride?: boolean;
  };
  homePath?: string;
}) {
  const configurationRef = OperationIdSchema.parse(input.operationId);
  const homePath = resolve(
    input.homePath ?? process.env.MATRIX_HOME ?? "/home/matrix/home",
  );
  const configuration = SupervisedAgentConfigurationSchema.parse({
    schemaVersion: 1,
    agent: input.agent,
    cwd: relativeOwnerPath(homePath, input.cwd),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    mode: input.mode ?? "default",
    approvalPolicy: input.approvalPolicy ?? "never",
    sandbox: {
      enabled: input.sandbox.enabled,
      ...(input.sandbox.mode ? { mode: input.sandbox.mode } : {}),
      writableRoots: (input.sandbox.writableRoots ?? [])
        .map((path) => relativeOwnerPath(homePath, path)),
      denyWriteRoots: (input.sandbox.denyWriteRoots ?? [])
        .map((path) => relativeOwnerPath(homePath, path)),
      ...(input.sandbox.adminOverride !== undefined
        ? { adminOverride: input.sandbox.adminOverride }
        : {}),
    },
    ...(input.providerEventPath
      ? {
          providerEventPath: relativeOwnerPath(
            homePath,
            input.providerEventPath,
          ).path,
        }
      : {}),
    ...(input.agent === "codex"
      ? {
          codexExpectedVersion: CODEX_VERIFIED_VERSION,
          ...(input.codexExecutable
            ? { codexExecutable: input.codexExecutable }
            : {}),
        }
      : {}),
  });
  return {
    descriptor: { kind: "agent" as const, configurationRef },
    matrixArgv: [
      "/opt/matrix/bin/matrix-terminal-pane",
      "agent",
    ] as const,
    configuration,
  };
}
