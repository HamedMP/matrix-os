import { isDaemonRunning, sendCommand } from "../daemon-client.js";
import { createTuiSafeError, normalizeTuiError, type TuiSafeError } from "./errors.js";

export type TuiDaemonState = "running" | "stopped" | "degraded";

export interface TuiDaemonStatus {
  state: TuiDaemonState;
  safeError?: TuiSafeError;
}

export interface TuiDaemonAdapterOptions {
  isRunning?: () => Promise<boolean>;
  send?: (command: string, args?: Record<string, unknown>, timeout?: number) => Promise<Record<string, unknown>>;
  timeoutMs?: number;
}

export async function getTuiDaemonStatus(
  options: TuiDaemonAdapterOptions = {},
): Promise<TuiDaemonStatus> {
  const check = options.isRunning ?? isDaemonRunning;
  try {
    return { state: (await check()) ? "running" : "stopped" };
  } catch (error) {
    return { state: "degraded", safeError: normalizeTuiError(error) };
  }
}

export async function sendTuiDaemonCommand(
  command: string,
  args: Record<string, unknown> = {},
  options: TuiDaemonAdapterOptions = {},
): Promise<Record<string, unknown>> {
  if (!/^[a-z][a-z0-9:_-]{0,63}$/i.test(command)) {
    throw createTuiSafeError("invalid_request");
  }
  const send = options.send ?? sendCommand;
  try {
    return await send(command, args, options.timeoutMs ?? 5_000);
  } catch (error) {
    throw normalizeTuiError(error);
  }
}
