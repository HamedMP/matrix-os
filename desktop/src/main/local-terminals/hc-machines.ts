// Machines the Terminal window's core reaches over ssh (spec 2706 layer 7),
// through herdr-core's own machine model: `machine.add`, `machine.list`,
// `machine.connect`, `machine.rm`. The core dials with the system ssh in
// batch mode, so keys stay in ~/.ssh, the ssh agent or the keychain, and
// OpenSSH checks host keys against known_hosts. Nothing here passes ssh
// options, and `via` (an arbitrary command) is never offered.
import { z } from "zod/v4";
import {
  LOCAL_MACHINE_NAME_PATTERN, LOCAL_MACHINES_MAX, LocalMachineStateSchema,
  type LocalMachine, type LocalMachineAddFailure,
} from "../../shared/local-terminals";
import { HcCallError, type HcConnection } from "./hc-client";

/** A dial over a slow network, with the ssh handshake and the core check there. */
const ADD_TIMEOUT_MS = 30_000;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const ADD_FAILURES = new Set<LocalMachineAddFailure>(["unreachable", "hc_missing", "incompatible", "name_taken", "already_added"]);

const ListedSchema = z.object({ machines: z.array(z.unknown()).max(LOCAL_MACHINES_MAX * 4) });
const MachineSchema = z.object({
  name: z.string().regex(LOCAL_MACHINE_NAME_PATTERN),
  target: z.string().max(1_024),
  state: z.string().max(32).optional().catch(undefined),
  temporary: z.boolean().optional().catch(false),
});

function machineFrom(raw: unknown, fallbackState: LocalMachine["state"] = "connecting"): LocalMachine | null {
  const parsed = MachineSchema.safeParse(raw);
  if (!parsed.success) return null;
  const state = LocalMachineStateSchema.safeParse(parsed.data.state);
  return {
    name: parsed.data.name,
    // Shown as typed; a `via` command line is never shown in full.
    target: parsed.data.target.replace(UNSAFE, "").slice(0, 255),
    state: state.success ? state.data : fallbackState,
    temporary: parsed.data.temporary === true,
  };
}

/** A name for a target the person did not name: its host, as herdr-core's terminal-name rules allow. */
export function machineNameFor(target: string): string {
  const address = target.replace(/^[^@]*@/, "");
  const bracketed = /^\[([^\]]*)\]/.exec(address);
  const host = bracketed ? bracketed[1]! : address.replace(/:\d+$/, "");
  const name = host.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 32);
  return LOCAL_MACHINE_NAME_PATTERN.test(name) ? name : "machine";
}

export async function listMachines(core: HcConnection): Promise<LocalMachine[]> {
  const listed = ListedSchema.parse(await core.call("machine.list", {}));
  return listed.machines.flatMap((raw) => machineFrom(raw) ?? []).slice(0, LOCAL_MACHINES_MAX);
}

export type AddMachineResult = { ok: true; machine: LocalMachine } | { ok: false; reason: LocalMachineAddFailure };

export async function addMachine(core: HcConnection, input: { target: string; name?: string }): Promise<AddMachineResult> {
  try {
    const result = await core.call("machine.add", { target: input.target, name: input.name ?? machineNameFor(input.target) }, ADD_TIMEOUT_MS);
    const machine = machineFrom(result, "connected");
    return machine ? { ok: true, machine } : { ok: false, reason: "invalid" };
  } catch (error: unknown) {
    if (error instanceof HcCallError) {
      const kind = error.kind as LocalMachineAddFailure;
      return { ok: false, reason: ADD_FAILURES.has(kind) ? kind : error.kind === "invalid_params" ? "invalid" : "unavailable" };
    }
    throw error;
  }
}
