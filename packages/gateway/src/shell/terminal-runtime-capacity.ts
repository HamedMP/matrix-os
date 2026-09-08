import { readFile } from "node:fs/promises";
import { join } from "node:path";

const HEADROOM = 128;
const RESERVATION_MS = 30_000;
const MAX_RESERVATIONS = 64;

async function taskBudget(root: string): Promise<{ current: number; maximum: number } | null> {
  let currentText: string;
  let maximumText: string;
  try {
    [currentText, maximumText] = await Promise.all([
      readFile(join(root, "pids.current"), "utf8"), readFile(join(root, "pids.max"), "utf8"),
    ]);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new Error("Terminal runtime capacity unavailable", { cause: error });
  }
  const current = Number(currentText.trim());
  const maximum = maximumText.trim() === "max" ? Infinity : Number(maximumText.trim());
  if (!/^\d+$/.test(currentText.trim()) || !Number.isSafeInteger(current) || current < 0
    || (maximum !== Infinity && (!/^\d+$/.test(maximumText.trim()) || !Number.isSafeInteger(maximum) || maximum <= 0))) {
    throw new Error("Terminal runtime capacity unavailable");
  }
  return { current, maximum };
}

export async function terminalTasksUnderPressure(root: string): Promise<boolean> {
  const budget = await taskBudget(root);
  return budget !== null && budget.current >= budget.maximum * 0.85;
}

/** Admission only: never kills sessions or changes cgroup limits. Call under the runtime mutation lock. */
export function createTerminalCapacityAdmission(options: { root: string; now?: () => number }) {
  const reservations = new Map<string, number>();
  const now = options.now ?? Date.now;
  return async (runtimeId: string): Promise<void> => {
    const time = now();
    for (const [id, expires] of reservations) if (expires <= time) reservations.delete(id);
    try {
      const existing = await readFile(join(options.root, `matrix-zellij@${runtimeId}.service`, "pids.current"), "utf8");
      if (/^\d+$/.test(existing.trim()) && Number(existing) > 0) return;
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new Error("Terminal runtime capacity unavailable", { cause: error });
      }
    }
    const budget = await taskBudget(options.root);
    if (!budget) return; // The aggregate cgroup does not exist before its first launch.
    const { current, maximum } = budget;
    if (reservations.has(runtimeId)) return;
    if (reservations.size >= MAX_RESERVATIONS || maximum - current < HEADROOM * (reservations.size + 1)) {
      throw new Error("Terminal runtime capacity unavailable");
    }
    reservations.set(runtimeId, time + RESERVATION_MS);
  };
}
