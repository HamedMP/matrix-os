// Internal ownership helper, not a public package entry or serialized proof.
import type { ChildProcess } from 'node:child_process';
import type { NativeControl, ExecInput, OwnedRole, OwnedState, BorrowedBirthLife } from './owned-root-startup.mjs';
interface ChildSlot {
  pair: ReturnType<NativeControl['controlPair']> | null;
  child: ChildProcess | null;
  birth: unknown;
  disposed: boolean;
  settled: boolean;
  error: boolean;
  observerPending?: boolean;
  result?: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
  wait?: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>;
}
export function unavailable(): Error;
export function createChildren(native: NativeControl, onOwnedChild: (role: OwnedRole, child: ChildProcess, life: Readonly<BorrowedBirthLife>) => void, fence: () => void): {
  slots: Record<OwnedRole, ChildSlot | null>;
  launch(role: OwnedRole, input: ExecInput): ChildSlot;
  alive(slot: ChildSlot): boolean;
  closeControls(): void;
  state(role: OwnedRole): OwnedState;
  disposeExited(): void;
};
