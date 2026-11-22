// How each added machine is reached (spec 2706 layer 7): its ssh target and
// options, kept by the app beside its core's data so a recovery terminal
// (Open in terminal) reaches it the same way. Fields only, never a command.
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  LOCAL_MACHINES_MAX, LocalMachineNameSchema, SshOptionsSchema, SshTargetSchema, type SshOptions,
} from "../../shared/local-terminals";
import { describeError } from "./describe-error";

const FileSchema = z.object({
  version: z.literal(1),
  machines: z.record(LocalMachineNameSchema, z.strictObject({
    target: SshTargetSchema, ssh: SshOptionsSchema.optional(), coreTarget: z.string().max(255).optional(),
  })),
});
export interface MachineSsh {
  target: string;
  ssh?: SshOptions;
  /** The machine's target as the core reported it when the app added it, to tell a reused name apart. */
  coreTarget?: string;
}

/** Whether saved settings still describe the core's machine of that name, not another host that took the name. */
export function machineSshMatches(entry: MachineSsh, current: { target: string }): boolean {
  return (entry.coreTarget ?? entry.target) === current.target;
}

export function createMachineSshStore(dataDir: string) {
  const path = join(dataDir, "machine-ssh.json");
  // Writes run one at a time, so two adds never lose each other's entry.
  let writes: Promise<unknown> = Promise.resolve();

  /**
   * The saved settings. A file that is missing is empty. One that exists but
   * cannot be read is empty for display, but stops a write (`forWrite`), so a
   * passing read error never replaces every machine's settings.
   */
  async function read(forWrite = false): Promise<Record<string, MachineSsh>> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return {};
      console.warn("[local-terminals] machine ssh unreadable:", describeError(error));
      if (forWrite) throw error;
      return {};
    }
    try {
      const parsed = FileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.machines : {};
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      return {};
    }
  }

  function change(update: (machines: Record<string, MachineSsh>) => void): Promise<void> {
    const next = writes.then(async () => {
      const machines = await read(true);
      update(machines);
      const names = Object.keys(machines);
      for (const name of names.slice(0, Math.max(0, names.length - LOCAL_MACHINES_MAX))) delete machines[name];
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, machines })}\n`, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    writes = next.catch(() => undefined);
    return next;
  }

  return {
    get: async (name: string): Promise<MachineSsh | undefined> => (await read())[name],
    all: () => read(),
    set: (name: string, entry: MachineSsh) => change((machines) => { machines[name] = entry; }),
    remove: (name: string) => change((machines) => { delete machines[name]; }),
  };
}
