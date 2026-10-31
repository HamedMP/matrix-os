import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { boundedOperation } from "../bounded-operation.js";
import { nativePiRoutineSource, type PiRoutineSource } from "../chat/pi-routine-source.js";
/** Feature pin only; existing native Pi installation/support policy and ordinary 0.99.2 remain unchanged. */
export async function preparePiRoutineSource(input: { command: string; cwd: string; env: Record<string, string>;
  runCommand(command: string, args: string[], options: { cwd: string; timeout: number; env?: Record<string, string> }): Promise<{ stdout: string; stderr: string }> }) {
  const source = nativePiRoutineSource(); if (!source?.current()) return undefined;
  try {
    const version = await boundedOperation(() => input.runCommand(input.command, ["--version"], { cwd: input.cwd, env: input.env, timeout: 1500 }), 1600);
    if (version.stdout.trim() === "1.0.0" && !version.stderr.trim() && source.current()) return source;
  } catch (error) { console.warn("[pi-routines] Version unavailable", error instanceof Error ? error.name : "UnknownError"); }
  source.end(); return undefined;
}
/** Query state on the held child before its one prompt; callback IDs never choose a source or session. */
export function createPiRoutinePrompt(input: { source?: PiRoutineSource; fd?: Duplex; sessionId: string; cwd: string; write(value: Record<string, unknown>): void; prompt(): void }) {
  const source = input.source, id = randomUUID();
  let started = false, closed = false, timer: ReturnType<typeof setTimeout> | undefined;
  const prompt = () => { if (started || closed) return; started = true; clearTimeout(timer); input.prompt(); };
  const end = () => { closed = true; clearTimeout(timer); source?.end(); };
  return { end,
    start() {
      if (!source || !input.fd || !source.current()) { source?.end(); prompt(); return; }
      source.attach(input.fd);
      timer = setTimeout(() => { source.end(); prompt(); }, 2000); timer.unref();
      input.write({ type: "get_state", id });
    },
    receive(value: unknown) {
      if (!source || closed || !value || typeof value !== "object") return;
      const frame = value as { id?: unknown; type?: unknown; command?: unknown; success?: unknown; data?: { sessionId?: unknown } };
      if (!started && frame.type === "response" && frame.id === id) {
        if (frame.command !== "get_state" || frame.success !== true || frame.data?.sessionId !== input.sessionId || !source.beforePrompt(input.sessionId, input.cwd)) source.end();
        prompt(); return;
      }
      source.observeEvent(value);
    },
  };
}
