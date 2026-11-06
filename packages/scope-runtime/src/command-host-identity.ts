import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { COMMAND_IPC_GROUP, COMMAND_WORKLOAD_USER, type CommandDirectoryTrust, type CommandSocketTrust } from "./command-ipc-policy.js";

const exec = promisify(execFile);
export type IdentityCommandRunner = (command: string, args: readonly string[]) => Promise<{ stdout: string }>;
const run: IdentityCommandRunner = (command, args) => exec(command, [...args], {
  env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 2_000, maxBuffer: 4_096,
});
function numericId(value: string): number {
  const id = Number(value);
  if (!/^(0|[1-9][0-9]{0,9})$/.test(value) || !Number.isSafeInteger(id) || id >= 0xffffffff) {
    throw new Error("Unsafe command IPC identity");
  }
  return id;
}
export async function lookupCommandIpcGroup(execute: IdentityCommandRunner = run): Promise<number> {
  const { stdout } = await execute("/usr/bin/getent", ["group", COMMAND_IPC_GROUP]);
  const match = /^matrix:[^:\n]*:([0-9]{1,10}):[^:\n]*\n?$/.exec(stdout);
  if (!match) throw new Error("Unsafe command IPC group");
  return numericId(match[1]!);
}
export interface CommandIdentityBinding {
  readonly unit: string;
  readonly root: string;
  readonly parent: CommandDirectoryTrust;
  validateProvenance(): Promise<void>;
}
export type CommandTrustResolver = (binding: CommandIdentityBinding) => Promise<CommandSocketTrust>;

const PROPERTIES = ["Id", "ActiveState", "MainPID", "InvocationID", "User", "DynamicUser", "PrivateUsers", "RootDirectory"];
async function unitIdentity(binding: CommandIdentityBinding, execute: IdentityCommandRunner): Promise<string> {
  const { stdout } = await execute("/usr/bin/systemctl", ["show", binding.unit, ...PROPERTIES.map(p => `--property=${p}`)]);
  if (stdout.length > 4096) throw new Error("Unsafe command IPC unit");
  const fields = new Map<string, string>(); // Bounded by eight property names; no retained registry.
  for (const line of stdout.trim().split("\n")) {
    const index = line.indexOf("="), key = line.slice(0, index);
    if (!PROPERTIES.includes(key) || fields.has(key)) throw new Error("Unsafe command IPC unit");
    fields.set(key, line.slice(index + 1));
  }
  if (fields.size !== PROPERTIES.length || fields.get("Id") !== binding.unit || fields.get("ActiveState") !== "active"
    || fields.get("User") !== COMMAND_WORKLOAD_USER || fields.get("DynamicUser") !== "yes" || fields.get("PrivateUsers") !== "yes"
    || fields.get("RootDirectory") !== binding.root || !/^[1-9][0-9]{0,9}$/.test(fields.get("MainPID") ?? "")
    || !/^[a-f0-9]{32}$/.test(fields.get("InvocationID") ?? "") || /^0+$/.test(fields.get("InvocationID")!)) {
    throw new Error("Unsafe command IPC unit");
  }
  return PROPERTIES.map(key => `${key}=${fields.get(key)}`).join("\n");
}

/** PID1 holds the dynamic identity while a stable active invocation brackets fixed-name NSS lookup. */
export async function resolveCommandSocketTrust(binding: CommandIdentityBinding, execute: IdentityCommandRunner = run): Promise<CommandSocketTrust> {
  await binding.validateProvenance();
  const before = await unitIdentity(binding, execute);
  const { stdout } = await execute("/usr/bin/getent", ["passwd", COMMAND_WORKLOAD_USER]);
  const match = /^matrix-scope-workload:[^:\n]*:([0-9]{1,10}):[0-9]{1,10}:[^:\n]*:[^:\n]*:[^:\n]*\n?$/.exec(stdout);
  if (!match) throw new Error("Unsafe command IPC workload identity");
  const workloadUid = numericId(match[1]!);
  if (workloadUid < 61184 || workloadUid > 65519) throw new Error("Unsafe command IPC workload identity");
  if (before !== await unitIdentity(binding, execute)) throw new Error("Changed command IPC unit");
  await binding.validateProvenance();
  return { ...binding.parent, workloadUid };
}
