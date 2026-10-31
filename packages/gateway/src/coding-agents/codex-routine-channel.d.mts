import type { ManagedShimFrame, ManagedTuple } from "./managed-launch-protocol.mjs";
export interface RoutineTurn { prompt: string; model?: string; modelOptions: Array<{ id: string; value: string | boolean }>; browser?: unknown }
export interface DynamicToolResult { id: string | number; result: { contentItems: Array<{ type: "inputText"; text: string }>; success: boolean } }
interface PrivateParent {
  connected?: boolean;
  send(frame: ManagedShimFrame, callback: (error?: Error | null) => void): unknown;
  on(name: string, callback: (...args: unknown[]) => void): unknown;
  off(name: string, callback: (...args: unknown[]) => void): unknown;
}
export const CODEX_ROUTINE_TOOL: { readonly type: "function"; readonly name: "matrix_routines"; readonly deferLoading: false; readonly description: string; readonly inputSchema: object };
export function createCodexRoutineChannel(options: {
  enabled?: boolean; parent?: PrivateParent; initialTurn(): RoutineTurn; enqueue(turn: RoutineTurn, clientRequestId?: string): boolean;
  current(binding: Readonly<ManagedTuple>): boolean; sendNative(response: DynamicToolResult): void;
}): { initial(signal: AbortSignal): Promise<RoutineTurn | undefined>; canRegister(): boolean;
  bind(turn: RoutineTurn, nativeGeneration: string, threadId: string, turnId: string, featureThread: boolean): void;
  handle(raw: unknown): boolean; end(): void; close(): void };
