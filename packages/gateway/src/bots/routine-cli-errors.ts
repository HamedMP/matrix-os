import { z } from "zod/v4";
import type { RoutineCliErrorCode } from "@matrix-os/contracts";

/** Stable safe errors; neither definition files nor DB/provider errors cross this boundary. */
export class RoutineCliError extends Error {
  constructor(readonly code: RoutineCliErrorCode) {
    super(code === "unavailable" ? "Routine request unavailable" : `Routine request failed: ${code}`);
    this.name = "RoutineCliError";
  }
}

export async function routineCliBoundary<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error: unknown) {
    if (error instanceof RoutineCliError) throw error;
    if (error instanceof z.ZodError) throw new RoutineCliError("invalid_input");
    console.warn("[routine-cli] Request failed", error instanceof Error ? error.name : "UnknownError");
    throw new RoutineCliError("unavailable");
  }
}
