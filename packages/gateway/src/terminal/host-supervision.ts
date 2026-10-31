import { z } from "zod/v4";
import { readLinuxProcess, sameProcess } from "./process-identity.js";
import type { TerminalBoundFrame } from "../coding-agents/terminal-launch-protocol.mjs";
export type TerminalManagerCommand = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
const UnitSchema = z.string().regex(/^matrix-terminal-native-[a-f0-9]{32}\.service$/);
const StateSchema = z.object({ Id: UnitSchema, LoadState: z.enum(["loaded", "not-found"]), ActiveState: z.enum(["active", "activating", "deactivating", "reloading", "inactive", "failed"]),
  SubState: z.string().min(1).max(64), MainPID: z.string().regex(/^(0|[1-9][0-9]{0,9})$/), InvocationID: z.string().regex(/^([a-f0-9]{32})?$/) }).strict();
/** Unknown states/errors throw. They cannot authorize descriptor or namespace deletion. */
function parseUnitState(unit: string, stdout: string) {
  if (Buffer.byteLength(stdout) > 8192) throw new Error("Terminal supervisor unavailable");
  const fields: Record<string, string> = {}; // Exactly six bounded systemd properties.
  for (const line of stdout.trim().split("\n")) {
    const at = line.indexOf("="), key = line.slice(0, at);
    if (at < 1 || Object.hasOwn(fields, key)) throw new Error("Terminal supervisor unavailable");
    fields[key] = line.slice(at + 1);
  }
  const state = StateSchema.parse(fields);
  if (state.Id !== unit) throw new Error("Terminal supervisor mismatch");
  const running = ["active", "activating", "deactivating", "reloading"].includes(state.ActiveState);
  const mainPid = Number(state.MainPID);
  if (!Number.isSafeInteger(mainPid) || mainPid > 2147483647 || state.LoadState === "not-found" && running
    || !running && mainPid !== 0) throw new Error("Terminal supervisor unavailable");
  return { running, active: state.LoadState === "loaded" && state.ActiveState === "active" && state.SubState === "running", mainPid, invocationId: state.InvocationID };
}
export async function inspectTerminalHostUnits(rawUnits: string[], run: TerminalManagerCommand) {
  if (rawUnits.length > 512) throw new Error("Terminal supervisor capacity reached");
  const units = rawUnits.map(unit => UnitSchema.parse(unit)), states = new Map<string, ReturnType<typeof parseUnitState>>(); // <=512, call-local.
  if (!units.length) return states;
  const { stdout } = await run("/usr/bin/systemctl", ["--user", "show", "--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID", ...units]);
  if (Buffer.byteLength(stdout) > 512 * 1024) throw new Error("Terminal supervisor unavailable");
  for (const block of stdout.trim().split(/\n\s*\n/)) {
    const id = /^Id=(.+)$/m.exec(block)?.[1];
    if (!id || !units.includes(id) || states.has(id)) throw new Error("Terminal supervisor unavailable");
    states.set(id, parseUnitState(id, block));
  }
  if (states.size !== units.length) throw new Error("Terminal supervisor unavailable");
  return states;
}
export async function inspectTerminalHostUnit(unit: string, run: TerminalManagerCommand) {
  return (await inspectTerminalHostUnits([unit], run)).get(unit)!;
}

export async function verifyTerminalHostBinding(options: {
  unit: string; generation: string; bound: TerminalBoundFrame; uid: number; run: TerminalManagerCommand; read?: typeof readLinuxProcess;
}) {
  const { bound, uid } = options, read = options.read ?? readLinuxProcess;
  if (bound.generation !== options.generation || bound.supervisor.uid !== uid || bound.host.uid !== uid || bound.root.uid !== uid
    || bound.root.gid !== bound.host.gid || bound.host.gid !== bound.supervisor.gid || bound.root.ppid !== bound.host.pid || bound.host.ppid !== bound.supervisor.pid) return false;
  try {
    const state = await inspectTerminalHostUnit(options.unit, options.run);
    if (!state.active || state.mainPid !== bound.supervisor.pid || state.invocationId !== bound.invocationId) return false;
    const [supervisor, host, root] = await Promise.all([read(bound.supervisor.pid), read(bound.host.pid), read(bound.root.pid)]);
    return sameProcess(bound.supervisor, supervisor) && sameProcess(bound.host, host) && sameProcess(bound.root, root)
      && host.ppid === supervisor.pid && root.ppid === host.pid;
  } catch (error) { console.warn("[terminal-host] Supervisor proof unavailable", error instanceof Error ? error.name : "UnknownError"); return false; }
}
