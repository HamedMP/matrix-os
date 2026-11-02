import type { ChildProcess } from 'node:child_process';
export type OwnedRole = 'initializer' | 'daemon';
export interface BorrowedBirthLife { readonly alive: () => boolean }
export interface ExecInput { readonly executable: string; readonly cwd: string; readonly environment: Readonly<Record<string, string>> }
export interface NativeControl {
  controlPair(): { channel: unknown; child: unknown; uid: number; gid: number };
  controlChildFd(child: unknown): number;
  receive(channel: unknown): null | false | { data: Buffer; writer: { pid: number; uid: number; gid: number } | null };
  send(channel: unknown, payload: Buffer): number;
  close(handle: unknown): void;
  retainChild(actualSpawnReturnPid: number): unknown;
  childAlive(birth: unknown): boolean;
  controlSendChildBirth(channel: unknown, payload: Buffer, birth: unknown): number;
}
export interface OwnedRootOptions extends ExecInput {
  readonly native: NativeControl;
  readonly layoutPath: string;
  readonly socketPath: string;
  readonly sessionName: string;
  readonly generation: Buffer;
  readonly deadlineNs: bigint;
  readonly validateInitialExec: (input: ExecInput) => Promise<void>;
  readonly validateDaemonExec: (input: ExecInput) => Promise<void>;
  readonly onOwnedChild: (role: OwnedRole, child: ChildProcess, birthLife: Readonly<BorrowedBirthLife>) => void;
}
export type OwnedDisposition = 'first_frame_complete' | 'unsent' | 'unknown';
export type OwnedState = 'not-spawned' | 'running' | 'exited' | 'unknown';
export interface OwnedRootStartup {
  start(): Promise<Readonly<{ disposition: OwnedDisposition }>>;
  fence(): void;
  observe(): Readonly<{ initializer: OwnedState; daemon: OwnedState; fenced: boolean }>;
  /** One pending observer per role; concurrent calls reject, timeout releases capacity. */
  waitForExit(role: OwnedRole, observationDeadlineNs: bigint): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>;
  disposeExited(): void;
}
export function createOwnedRootStartup(options: OwnedRootOptions): Readonly<OwnedRootStartup>;
