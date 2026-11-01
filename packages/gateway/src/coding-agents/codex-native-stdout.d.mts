import type { ChildProcess, SpawnOptions } from "node:child_process";

declare const nativeHandle: unique symbol;
/** Opaque ownership only; no image, owner, policy or source authority. */
export interface NativeStdoutHandle { readonly [nativeHandle]: never }
export interface NativeStdoutApi {
  stdoutPair(): { receiver: NativeStdoutHandle; writer: NativeStdoutHandle; uid: number; gid: number };
  stdoutWriterFd(writer: NativeStdoutHandle): number;
  stdoutReceive(receiver: NativeStdoutHandle): null | false | {
    data: Buffer; writer: null | { pid: number; uid: number; gid: number };
  };
  retainChild(pid: number): NativeStdoutHandle;
  childAlive(birth: NativeStdoutHandle): boolean;
  close(handle: NativeStdoutHandle): void;
}
/** Recheck at actual callback delivery; transport currentness alone grants nothing. */
export type NativeStdoutCurrent = () => boolean;
export interface NativeStdoutSession {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnFailed?: true }>;
  consume(options: {
    onMessage(message: unknown, current: NativeStdoutCurrent): Promise<void>;
    /** Ordinary I/O only. Must be synchronous; caller owns any sink capacity. */
    onBytes?(bytes: Buffer): void;
  }): Promise<void>;
  fence(): void;
  isFenced(): boolean;
  /** Fences/cleans reader only. Does not kill child or confirm native exit. */
  closeReader(): void;
}
export function createCodexNativeStdout(options: {
  native: NativeStdoutApi;
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Internal injection seam; production default is actual child_process.spawn. */
  spawn?(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
}): NativeStdoutSession;
