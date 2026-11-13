import type { Readable, Writable } from "node:stream";
interface ManagedWrapperChild {
  connected?: boolean;
  send(frame: unknown, callback: (error?: Error | null) => void): unknown;
  on(name: string, callback: (...args: unknown[]) => void): unknown;
  once(name: string, callback: (...args: unknown[]) => void): unknown;
  disconnect?(): void;
}
/** Uses the actual service-owned anonymous host pipes and exact held child IPC. */
export function attachManagedLaunchWrapper(child: ManagedWrapperChild, digest: string, transport?: { input: Readable; output: Writable }, protocol?: "codex" | "terminal"): { close(): void };
