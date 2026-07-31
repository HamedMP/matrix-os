import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod/v4";
import type { AgentLaunchSpec } from "./agent-launcher.js";
import type { createUserSystemdTerminalRuntime, UserSystemdTerminalDescriptor } from "./shell/user-systemd-terminal-runtime.js";
import { createZellijAdapter, type ZellijAdapter } from "./shell/zellij.js";
import { createZellijRuntime, type ZellijHealth, type ZellijLayoutResult, type ZellijStartResult } from "./zellij-runtime.js";

type RuntimeController = Pick<
  ReturnType<typeof createUserSystemdTerminalRuntime>,
  "create" | "delete" | "get" | "isRunning"
>;
type LayoutRuntime = Pick<ReturnType<typeof createZellijRuntime>, "generateLayout">;
const MAX_GENERATION_ADAPTERS = 8;
const LaunchEnvironmentSchema = z.record(
  z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  z.string().max(8192).refine((value) => !value.includes("\0")),
).refine((value) => Object.keys(value).length <= 64);

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error
    && "code" in err
    && (err as NodeJS.ErrnoException).code === code;
}

async function removeTemporaryRuntimeFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (err: unknown) {
    if (!isErrnoCode(err, "ENOENT")) {
      console.warn("[terminal-runtime] failed to remove temporary workspace runtime file");
    }
  }
}

async function writeImmutableFileExclusive(path: string, content: string, maxBytes: number): Promise<void> {
  if (Buffer.byteLength(content) > maxBytes) throw new Error("Workspace runtime file is too large");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, { flag: "wx", mode: 0o600 });
    try {
      await link(tempPath, path);
    } catch (err: unknown) {
      if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST")) throw err;
      if (await readFile(path, "utf8") !== content) throw new Error("Workspace runtime file conflicts");
    }
  } finally {
    await removeTemporaryRuntimeFile(tempPath);
  }
}

export function workspaceRuntimeId(sessionId: string): string {
  const digest = createHash("sha256")
    .update("matrix-workspace-runtime-v1\0")
    .update(sessionId)
    .digest("hex")
    .slice(0, 32);
  return `rt_${digest}`;
}

export function createUserSystemdZellijRuntime(options: {
  homePath: string;
  generation: string;
  controller: RuntimeController;
  terminalRuntimeRoot?: string;
  layoutRuntime?: LayoutRuntime;
  baseAdapter?: ZellijAdapter;
  adapterFactory?: (binaryPath: string) => ZellijAdapter;
}) {
  const homePath = resolve(options.homePath);
  const terminalRuntimeRoot = resolve(options.terminalRuntimeRoot ?? "/opt/matrix/terminal-runtime");
  const uid = process.getuid?.();
  const terminalEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(uid == null ? {} : { XDG_RUNTIME_DIR: `/run/user/${uid}` }),
  };
  const layoutRuntime = options.layoutRuntime ?? createZellijRuntime({ homePath });
  const currentBinary = join(terminalRuntimeRoot, "generations", options.generation, "zellij");
  const baseAdapter = options.baseAdapter ?? createZellijAdapter({ homePath, binaryPath: currentBinary, env: terminalEnv });
  const adapterFactory = options.adapterFactory ?? ((binaryPath: string) => createZellijAdapter({
    homePath,
    binaryPath,
    env: terminalEnv,
    manageConfig: false,
  }));
  const generationAdapters = new Map<string, ZellijAdapter>();

  function adapterFor(descriptor: UserSystemdTerminalDescriptor): ZellijAdapter {
    const cached = generationAdapters.get(descriptor.generation);
    if (cached) {
      generationAdapters.delete(descriptor.generation);
      generationAdapters.set(descriptor.generation, cached);
      return cached;
    }
    if (generationAdapters.size >= MAX_GENERATION_ADAPTERS) {
      const oldest = generationAdapters.keys().next().value as string | undefined;
      if (oldest) generationAdapters.delete(oldest);
    }
    const adapter = adapterFactory(join(terminalRuntimeRoot, "generations", descriptor.generation, "zellij"));
    generationAdapters.set(descriptor.generation, adapter);
    return adapter;
  }

  async function descriptorFor(sessionId: string): Promise<UserSystemdTerminalDescriptor> {
    const descriptor = await options.controller.get(workspaceRuntimeId(sessionId));
    if (!descriptor || descriptor.scope !== "workspace" || descriptor.displayName !== sessionId) {
      throw new Error("Workspace runtime unavailable");
    }
    return descriptor;
  }

  return {
    generateLayout(input: { sessionId: string; launch: AgentLaunchSpec }): Promise<ZellijLayoutResult> {
      return layoutRuntime.generateLayout(input);
    },

    async start(input: { sessionId: string; launch: AgentLaunchSpec }): Promise<ZellijStartResult> {
      const layout = await layoutRuntime.generateLayout(input);
      const runtimeId = workspaceRuntimeId(input.sessionId);
      const layoutContent = await readFile(layout.layoutPath, "utf8");
      const layoutDigest = createHash("sha256").update(layoutContent).digest("hex").slice(0, 16);
      const layoutPath = join(
        homePath,
        "system",
        "zellij",
        "runtime-layouts",
        `${runtimeId}-${layoutDigest}.kdl`,
      );
      await writeImmutableFileExclusive(layoutPath, layoutContent, 100_000);
      const parsedEnvironment = LaunchEnvironmentSchema.parse(input.launch.env);
      const environmentContent = `${JSON.stringify(parsedEnvironment, null, 2)}\n`;
      const environmentDigest = createHash("sha256")
        .update(environmentContent)
        .digest("hex")
        .slice(0, 16);
      const environmentPath = join(
        homePath,
        "system",
        "terminal-runtimes",
        "env",
        `${runtimeId}-${environmentDigest}.json`,
      );
      await writeImmutableFileExclusive(environmentPath, environmentContent, 64 * 1024);
      let descriptor;
      try {
        descriptor = await options.controller.create({
          runtimeId,
          scope: "workspace",
          kind: input.launch.command === "bash" ? "shell" : "agent",
          displayName: input.sessionId,
          cwd: input.launch.cwd,
          layoutPath,
          environmentPath,
        });
      } catch (err: unknown) {
        let persisted: UserSystemdTerminalDescriptor | null;
        try {
          persisted = await options.controller.get(runtimeId);
        } catch (lookupErr: unknown) {
          if (!(lookupErr instanceof Error)) throw lookupErr;
          console.warn("[terminal-runtime] failed to reconcile workspace runtime after create failure");
          throw err;
        }
        if (persisted?.layoutPath !== layoutPath) await rm(layoutPath, { force: true });
        if (persisted?.environmentPath !== environmentPath) await rm(environmentPath, { force: true });
        throw err;
      }
      return {
        ok: true,
        status: "running",
        sessionName: descriptor.sessionName,
        layoutPath: descriptor.layoutPath,
      };
    },

    attachCommand(sessionId: string): string[] {
      return ["matrix-terminal-attach", workspaceRuntimeId(sessionId)];
    },

    observeCommand(sessionId: string): string[] {
      return ["matrix-terminal-attach", workspaceRuntimeId(sessionId), "--index", "0"];
    },

    async sendInput(sessionId: string, input: string, _signal?: AbortSignal): Promise<void> {
      const descriptor = await descriptorFor(sessionId);
      await adapterFor(descriptor).sendInput(descriptor.sessionName, input);
    },

    async kill(sessionId: string): Promise<{ ok: true }> {
      await options.controller.delete(workspaceRuntimeId(sessionId));
      return { ok: true };
    },

    isAlive(sessionId: string): Promise<boolean> {
      return options.controller.isRunning(workspaceRuntimeId(sessionId));
    },

    async health(): Promise<ZellijHealth> {
      const health = await baseAdapter.health();
      return health.ok
        ? { available: true, status: "ok", fallbackReason: null, version: null }
        : { available: false, status: "degraded", fallbackReason: "zellij_unavailable", version: null };
    },
  };
}
