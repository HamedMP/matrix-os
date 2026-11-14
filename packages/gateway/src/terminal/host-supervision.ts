import { readLinuxProcess, sameProcess } from "./process-identity.js";
import type { TerminalBoundFrame } from "../coding-agents/terminal-launch-protocol.mjs";
import { inspectTerminalHostUnit, type TerminalManagerCommand } from "@matrix-os/terminal-runtime/native-host-unit";
export { inspectTerminalHostUnit, inspectTerminalHostUnits, stopTerminalHostUnit, type TerminalManagerCommand } from "@matrix-os/terminal-runtime/native-host-unit";

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
