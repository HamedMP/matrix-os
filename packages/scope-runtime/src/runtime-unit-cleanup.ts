/** Host-only quiescence fence for deleting disposable runtime artifacts. */
export interface RuntimeCleanupCommandRunner {
  (command: string, args: readonly string[]): Promise<{ stdout: string }>;
}
export interface RuntimeCleanupIdentity { readonly unit: string; readonly root: string }
const PROPERTIES = ["Id", "LoadState", "ActiveState", "SubState", "MainPID", "ControlPID", "ControlGroup", "KillMode", "RootDirectory"] as const;
type Snapshot = Record<typeof PROPERTIES[number], string>;

async function observe(execute: RuntimeCleanupCommandRunner, identity: RuntimeCleanupIdentity): Promise<Snapshot> {
  const { stdout } = await execute("/usr/bin/systemctl", ["show", identity.unit, "--all", ...PROPERTIES.map(key => `--property=${key}`)]);
  if (Buffer.byteLength(stdout) > 4096) throw new Error("Scope runtime cleanup identity exceeds capacity");
  const fields: Partial<Snapshot> = {};
  for (const line of stdout.trimEnd().split("\n")) {
    const separator = line.indexOf("="), key = line.slice(0, separator) as keyof Snapshot;
    if (!PROPERTIES.includes(key) || Object.hasOwn(fields, key)) throw new Error("Unsafe scope runtime cleanup identity");
    fields[key] = line.slice(separator + 1);
  }
  if (Object.keys(fields).length !== PROPERTIES.length || fields.Id !== identity.unit
    || !/^(0|[1-9][0-9]{0,9})$/.test(fields.MainPID!) || !/^(0|[1-9][0-9]{0,9})$/.test(fields.ControlPID!)) {
    throw new Error("Unsafe scope runtime cleanup identity");
  }
  return fields as Snapshot;
}
function terminal(snapshot: Snapshot): boolean {
  return ["inactive", "failed"].includes(snapshot.ActiveState) && ["dead", "failed"].includes(snapshot.SubState)
    && snapshot.MainPID === "0" && snapshot.ControlPID === "0" && snapshot.ControlGroup === "";
}
function missing(snapshot: Snapshot): boolean {
  return snapshot.LoadState === "not-found" && snapshot.ActiveState === "inactive" && snapshot.SubState === "dead"
    && terminal(snapshot) && snapshot.RootDirectory === "";
}
function assertOwned(snapshot: Snapshot, identity: RuntimeCleanupIdentity): void {
  if (snapshot.LoadState !== "loaded" || snapshot.RootDirectory !== identity.root || snapshot.KillMode !== "control-group") {
    throw new Error("Unsafe scope runtime cleanup ownership");
  }
}

/** Never infer quiescence from is-active/exit codes or from a discovery snapshot. */
export async function quiesceRuntimeUnit(execute: RuntimeCleanupCommandRunner, identity: RuntimeCleanupIdentity): Promise<void> {
  const before = await observe(execute, identity);
  if (missing(before)) return;
  assertOwned(before, identity);
  // No --no-block: PID1 must complete the scoped control-group stop job.
  await execute("/usr/bin/systemctl", ["stop", identity.unit]);
  const after = await observe(execute, identity);
  if (missing(after)) return;
  assertOwned(after, identity);
  if (!terminal(after)) throw new Error("Scope runtime cleanup closure unverified");
  // Preserve failure evidence whenever ownership/closure is uncertain.
  await execute("/usr/bin/systemctl", ["reset-failed", identity.unit]);
}
