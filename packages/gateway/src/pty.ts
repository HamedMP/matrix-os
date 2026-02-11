import { spawn as nodePtySpawn, type IPty } from "node-pty";

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

export function createPtyHandler(
  homePath: string,
  spawnFn: SpawnFn = nodePtySpawn as unknown as SpawnFn,
) {
  let ptyProcess: IPty | null = null;
  let sendFn: SendFn | null = null;

  return {
    onSend(fn: SendFn) {
      sendFn = fn;
    },

    open() {
      const shell = process.env.SHELL ?? "/bin/bash";

      ptyProcess = spawnFn(shell, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: homePath,
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
