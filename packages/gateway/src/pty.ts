import { existsSync } from "node:fs";
import { resolveWithinHome } from "./path-security.js";

type IPty = import("node-pty").IPty;

export type PtyMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type PtyServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; code: number };

type SendFn = (msg: PtyServerMessage) => void;

export type SpawnFn = (
  shell: string,
  args: string[],
  opts: Record<string, unknown>,
) => IPty;

let _defaultSpawn: SpawnFn | undefined;
async function getDefaultSpawn(): Promise<SpawnFn> {
  if (!_defaultSpawn) {
    const pty = await import("node-pty");
    _defaultSpawn = pty.spawn as unknown as SpawnFn;
  }
  return _defaultSpawn;
}

export function createPtyHandler(
  homePath: string,
  spawnFn?: SpawnFn,
  cwd?: string,
) {
  let ptyProcess: IPty | null = null;
  let sendFn: SendFn | null = null;

  return {
    onSend(fn: SendFn) {
      sendFn = fn;
    },

    async open() {
      const resolvedSpawn = spawnFn ?? await getDefaultSpawn();
      const shell = process.env.SHELL ?? "/bin/bash";
      const validatedCwd = cwd ? resolveWithinHome(homePath, cwd) : null;
      const targetCwd = validatedCwd && existsSync(validatedCwd) ? validatedCwd : homePath;

      ptyProcess = resolvedSpawn(shell, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: targetCwd,
        env: { ...process.env },
      });

      ptyProcess.onData((data: string) => {
        sendFn?.({ type: "output", data });
      });

      ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
        sendFn?.({ type: "exit", code: exitCode });
      });
    },

    onMessage(msg: PtyMessage) {
      if (!ptyProcess) return;

      switch (msg.type) {
        case "input":
          ptyProcess.write(msg.data);
          break;
        case "resize":
          ptyProcess.resize(msg.cols, msg.rows);
          break;
      }
    },

    close() {
      ptyProcess?.kill();
      ptyProcess = null;
    },
  };
}
