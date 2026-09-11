import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod/v4";
import type { createUserSystemdTerminalRuntime } from "./user-systemd-controller.js";
import type { WorkspaceZellijLifecycle, WorkspaceZellijTarget } from "./zellij-adapter.js";

const LogicalWorkspaceSessionSchema = z.string().regex(/^matrix-w-[0-9a-f]{32}$/);
const CanonicalSizeSchema = z.object({
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
}).strict();
const WORKSPACE_LAYOUT = 'layout {\n  tab name="matrix-bootstrap" focus=true {\n    pane\n  }\n}\n';

type WorkspaceRuntimeController = Pick<
  ReturnType<typeof createUserSystemdTerminalRuntime>,
  "create" | "delete" | "get" | "start"
>;

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

async function writeLayoutExclusive(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, WORKSPACE_LAYOUT, { flag: "wx", mode: 0o600 });
    try {
      await link(temporaryPath, path);
    } catch (error: unknown) {
      if (!isErrnoCode(error, "EEXIST")) throw error;
      if (await readFile(path, "utf8") !== WORKSPACE_LAYOUT) {
        throw new Error("Terminal workspace layout conflicts");
      }
    }
  } finally {
    try {
      await rm(temporaryPath, { force: true });
    } catch (error: unknown) {
      if (!isErrnoCode(error, "ENOENT")) {
        console.warn("[terminal-runtime] workspace layout cleanup deferred", {
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
  }
}

export function workspaceRuntimeId(logicalSessionNameInput: string): string {
  const logicalSessionName = LogicalWorkspaceSessionSchema.parse(logicalSessionNameInput);
  const digest = createHash("sha256")
    .update("matrix-project-workspace-runtime-v1\0")
    .update(logicalSessionName)
    .digest("hex")
    .slice(0, 32);
  return `rt_${digest}`;
}

export function createUserSystemdWorkspaceLifecycle(options: {
  homePath: string;
  controller: WorkspaceRuntimeController;
  terminalRuntimeRoot?: string;
}): WorkspaceZellijLifecycle {
  const homePath = resolve(options.homePath);
  const terminalRuntimeRoot = resolve(options.terminalRuntimeRoot ?? "/opt/matrix/terminal-runtime");

  function resolveWorkspaceSessionName(logicalSessionName: string): string {
    return `matrix-${workspaceRuntimeId(logicalSessionName)}`;
  }

  function targetFromDescriptor(
    logicalSessionName: string,
    descriptor: Awaited<ReturnType<WorkspaceRuntimeController["start"]>>,
  ): WorkspaceZellijTarget {
    const expectedSessionName = resolveWorkspaceSessionName(logicalSessionName);
    if (descriptor.scope !== "workspace"
      || descriptor.kind !== "shell"
      || descriptor.displayName !== logicalSessionName
      || descriptor.sessionName !== expectedSessionName
      || descriptor.cwd !== homePath) {
      throw new Error("Terminal workspace runtime identity conflicts");
    }
    return {
      sessionName: descriptor.sessionName,
      binaryPath: join(terminalRuntimeRoot, "generations", descriptor.generation, "zellij"),
    };
  }

  return {
    async resolveWorkspaceTarget(logicalSessionNameInput) {
      const logicalSessionName = LogicalWorkspaceSessionSchema.parse(logicalSessionNameInput);
      const existing = await options.controller.get(workspaceRuntimeId(logicalSessionName));
      if (!existing) throw new Error("Terminal workspace runtime is unavailable");
      return targetFromDescriptor(logicalSessionName, { ...existing, lifecycle: "running" });
    },

    async ensureWorkspaceSession(logicalSessionNameInput, sizeInput) {
      const logicalSessionName = LogicalWorkspaceSessionSchema.parse(logicalSessionNameInput);
      CanonicalSizeSchema.parse(sizeInput);
      const runtimeId = workspaceRuntimeId(logicalSessionName);
      const existing = await options.controller.get(runtimeId);
      if (existing) {
        const running = await options.controller.start(runtimeId);
        return targetFromDescriptor(logicalSessionName, running);
      }

      const layoutPath = join(
        homePath,
        "system",
        "zellij",
        "runtime-layouts",
        `${runtimeId}-workspace.kdl`,
      );
      await writeLayoutExclusive(layoutPath);
      const created = await options.controller.create({
        runtimeId,
        scope: "workspace",
        kind: "shell",
        displayName: logicalSessionName,
        cwd: homePath,
        layoutPath,
      });
      return targetFromDescriptor(logicalSessionName, created);
    },

    async deleteWorkspaceSession(logicalSessionName) {
      await options.controller.delete(workspaceRuntimeId(logicalSessionName));
    },
  };
}
