import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ChClient } from "./ch-client.js";
import type { Exec } from "./exec.js";
import type { VmRecord, VmState, VmStore } from "./vm-store.js";

// Startup reconciliation: a hostd crash or restart can leave a record in a
// transitional state. The VM units are independent of hostd, so systemd says
// what actually happened: an active unit means the VM is running; an inactive
// one with a complete snapshot taken after the transition began means the
// suspend finished; anything else is failed, and the next wake cold-boots it.
// A VM left paused that cannot be resumed is marked stopped (its disk is
// intact), so the next wake stops its units and cold-boots it. A record that
// says running is checked too: after a host reboot, or a crash between stopping
// the units and saving, its VM is off, and it is marked stopped so it can wake.
// Runs before the API listens, so no lifecycle operation can race it.

const TRANSITIONAL: ReadonlySet<VmState> = new Set<VmState>(["creating", "suspending", "resuming"]);
const SNAPSHOT_FILES = ["state.json", "memory-ranges"] as const;

export interface ReconcileDeps {
  store: Pick<VmStore, "list" | "put">;
  exec: Exec;
  ch: (id: string) => ChClient;
  snapshotsDir: string;
  execTimeoutMs?: number;
  chTimeoutMs?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  now?: () => number;
}

const errorFields = (error: unknown) =>
  error instanceof Error ? { error: error.name, message: error.message } : { error: String(error) };

export async function reconcileVms(deps: ReconcileDeps): Promise<void> {
  const log = deps.log ?? ((event, fields) => console.error(JSON.stringify({ event, ...fields })));
  const now = deps.now ?? Date.now;
  const execTimeoutMs = deps.execTimeoutMs ?? 10_000;
  const chTimeoutMs = deps.chTimeoutMs ?? 10_000;

  async function isActive(unit: string): Promise<boolean> {
    const result = await deps.exec(["systemctl", "is-active", unit], { signal: AbortSignal.timeout(execTimeoutMs) });
    return result.code === 0;
  }

  // The newest file mtime of a complete snapshot, or null.
  async function snapshotTakenAt(id: string): Promise<number | null> {
    let newest = 0;
    for (const name of SNAPSHOT_FILES) {
      try {
        const info = await stat(join(deps.snapshotsDir, id, name));
        if (!info.isFile()) return null;
        newest = Math.max(newest, info.mtimeMs);
      } catch (error: unknown) {
        if ((error as { code?: unknown }).code === "ENOENT") return null;
        throw error;
      }
    }
    return newest;
  }

  // A suspend or restore interrupted between pause and stop can leave the VM
  // paused. Returns false when the VM may still be paused.
  async function unpause(id: string): Promise<boolean> {
    const client = deps.ch(id);
    try {
      if ((await client.info(AbortSignal.timeout(chTimeoutMs))).state === "Paused") {
        await client.resume(AbortSignal.timeout(chTimeoutMs));
      }
      return true;
    } catch (error: unknown) {
      log("reconcile.unpause_failed", { id, ...errorFields(error) });
      return false;
    } finally {
      await client.close();
    }
  }

  const unitsActive = async (id: string) =>
    (await isActive(`matrix-vm@${id}.service`)) || (await isActive(`matrix-vm-restore@${id}.service`));

  async function settle(record: VmRecord): Promise<Partial<VmRecord>> {
    const { id } = record;
    if (await unitsActive(id)) {
      if (await unpause(id)) return { state: "running" };
      return record.state === "creating" ? failed(record) : { state: "stopped", snapshot: null };
    }
    const takenAt = await snapshotTakenAt(id);
    if (takenAt !== null && takenAt >= Date.parse(record.updatedAt)) {
      return {
        state: "suspended",
        snapshot: { dir: join(deps.snapshotsDir, id), takenAt: new Date(takenAt).toISOString(), chVersion: record.chVersion },
      };
    }
    return failed(record);
  }

  // Only a record that never finished creating holds no owner data.
  function failed(record: VmRecord): Partial<VmRecord> {
    return record.state === "creating" ? { state: "failed", failedDuring: "create" } : { state: "failed" };
  }

  // A running record whose units are inactive is stopped. A query failure
  // leaves it as it is: marking a live VM stopped would make a wake reboot it.
  async function checkRunning(record: VmRecord): Promise<void> {
    try {
      if (await unitsActive(record.id)) return;
    } catch (error: unknown) {
      log("reconcile.query_failed", { id: record.id, ...errorFields(error) });
      return;
    }
    await deps.store.put({ ...record, state: "stopped", snapshot: null, memoryReservationMiB: undefined, updatedAt: new Date(now()).toISOString() });
    log("reconcile.settled", { id: record.id, from: record.state, to: "stopped" });
  }

  for (const record of await deps.store.list()) {
    if (record.state === "running") {
      await checkRunning(record);
      continue;
    }
    if (!TRANSITIONAL.has(record.state)) continue;
    let patch: Partial<VmRecord>;
    try {
      patch = await settle(record);
    } catch (error: unknown) {
      log("reconcile.query_failed", { id: record.id, ...errorFields(error) });
      patch = failed(record);
    }
    await deps.store.put({ ...record, ...patch, updatedAt: new Date(now()).toISOString() });
    log("reconcile.settled", { id: record.id, from: record.state, to: patch.state });
  }
}
