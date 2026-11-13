/**
 * Routine-only exposure is intentionally closed until the pinned native loader,
 * discovery and home-semantics qualification is completed. Ordinary Chat keeps
 * its existing environment/session. A package version alone cannot open this gate.
 */
export const OPENCODE_ROUTINE_VERSION = "1.16.0";
export const OPENCODE_ROUTINE_PIN = "6cb74317a6efacd656483cb0489d8e7e3701c12e";
export interface OpenCodeRoutineBootstrap {
  environment: Record<string, string>;
  close(): Promise<void>;
}
export const prepareOpenCodeRoutineBootstrap: (input: {
  command: string; cwd: string; env: Record<string, string>;
}) => Promise<OpenCodeRoutineBootstrap | undefined> = async () => undefined;
