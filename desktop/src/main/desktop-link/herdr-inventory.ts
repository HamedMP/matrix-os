// Read machine.list on already-running local Herdr Core sockets. Neither socket
// is exposed through Desktop Link; terminal control stays on the private Core.
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod/v4";
import { DESKTOP_LINK_CONTROL_MAX_BYTES, DESKTOP_LINK_MAX_HERDR_MACHINES, DesktopLinkHerdrMachineSchema, type DesktopLinkHerdrMachine } from "@matrix-os/contracts/desktop-link";
import { connectHc } from "@matrix-os/herdr-core-client/client";
import { LOCAL_MACHINES_MAX, LocalMachineNameSchema } from "../../shared/local-terminals";

export interface ComputerInventory { machines: readonly DesktopLinkHerdrMachine[]; partial: boolean }
export type ReadMatrixInventory = (ownerId: string) => Promise<ComputerInventory>;

export function standardHerdrSocket(env: NodeJS.ProcessEnv, home: string): string | undefined {
  const session = env.HC_SESSION || "default";
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(session)) return undefined;
  if (env.XDG_RUNTIME_DIR) {
    return isAbsolute(env.XDG_RUNTIME_DIR) ? join(env.XDG_RUNTIME_DIR, "herdr-core", session + ".sock") : undefined;
  }
  const state = env.XDG_STATE_HOME || join(home, ".local", "state");
  return isAbsolute(state) ? join(state, "herdr-core", session, session + ".sock") : undefined;
}

const MachineList = z.object({ machines: z.array(z.unknown()).max(LOCAL_MACHINES_MAX * 4) });
const Machine = z.object({ name: LocalMachineNameSchema, state: z.unknown() });
export async function readCoreInventory(path: string, coreScope?: "private"): Promise<ComputerInventory> {
  const [dir, socket] = await Promise.all([lstat(dirname(path)), lstat(path)]);
  const uid = process.getuid?.();
  if (uid === undefined || !dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o077) !== 0 || !socket.isSocket() || socket.uid !== uid) {
    throw new Error("untrusted local Core socket");
  }
  const core = await connectHc({
    open: () => createConnection(path),
    accepts: ({ methods }) => methods.includes("machine.list"),
    timeoutMs: 1_500,
  });
  try {
    const { machines: rows } = MachineList.parse(await core.call("machine.list", {}));
    const machines: DesktopLinkHerdrMachine[] = [];
    for (const row of rows) {
      const machine = Machine.safeParse(row);
      if (!machine.success) continue;
      const { name, state } = machine.data;
      machines.push({ name, ...(coreScope ? { core: coreScope } : {}), state: state === "connected" || state === "unreachable" ? state : "unknown" });
    }
    return { machines, partial: machines.length !== rows.length };
  } finally {
    core.close();
  }
}

export async function collectDesktopInventory(
  sockets: { privateCore?: string; defaultCore?: string }, ownerId: string, matrixInventory?: ReadMatrixInventory,
): Promise<ComputerInventory | undefined> {
  const reads: Array<Promise<ComputerInventory>> = [];
  if (sockets.privateCore && sockets.privateCore !== sockets.defaultCore) {
    reads.push(readCoreInventory(sockets.privateCore, "private"));
  }
  reads.push(sockets.defaultCore ? readCoreInventory(sockets.defaultCore) : Promise.reject(new Error("unsupported session")));
  if (matrixInventory) reads.push(matrixInventory(ownerId));
  const results = await Promise.allSettled(reads);
  if (!results.some((result) => result.status === "fulfilled")) return undefined;

  const entries = new Map<string, DesktopLinkHerdrMachine>();
  let partial = false;
  for (const result of results) {
    if (result.status === "rejected") { partial = true; continue; }
    partial ||= result.value.partial;
    for (const row of result.value.machines) {
      const parsed = DesktopLinkHerdrMachineSchema.safeParse(row);
      if (!parsed.success) { partial = true; continue; }
      const machine = parsed.data;
      const key = machine.source === "matrix" ? "matrix/" + machine.name + "/" + machine.runtimeSlot : (machine.core ?? "default") + "/" + machine.name;
      const previous = entries.get(key);
      if (previous) {
        if (previous.state !== machine.state) previous.state = "unknown";
      } else if (entries.size < DESKTOP_LINK_MAX_HERDR_MACHINES) {
        entries.set(key, machine);
      } else {
        partial = true;
      }
    }
  }
  const machines = [...entries.values()];
  // Long handles and slot names can exceed the control frame cap. Reserve space for the partial
  // flag, even before the first row is dropped.
  while (Buffer.byteLength(JSON.stringify({ t: "pong", herdrMachines: machines, herdrMachinesPartial: true })) > DESKTOP_LINK_CONTROL_MAX_BYTES) {
    machines.pop();
    partial = true;
  }
  return { machines, partial };
}
