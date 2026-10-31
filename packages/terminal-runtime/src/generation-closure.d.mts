export interface TerminalClosureRuntime { version: string; modules: string; napi: string; platform: string; arch: string; libc: string; nodePty: string; nodeAddonApi: string; writerNapi: number; protocol: number }
export interface TerminalClosureManifest { version: 2; runtime: TerminalClosureRuntime; assets: { path: string; sha256: string; size: number; mode: number }[] }
export function terminalClosureGeneration(manifest: TerminalClosureManifest): string;
export function createTerminalClosureManifest(directory: string, runtime: TerminalClosureRuntime): Promise<TerminalClosureManifest>;
export function validateTerminalClosure(directory: string, generation: string, expectedRuntime?: TerminalClosureRuntime): Promise<TerminalClosureManifest>;
export function legacyTerminalGeneration(directory: string): Promise<string>;
export function validateTerminalClosureIfPresent(directory: string, generation: string): Promise<TerminalClosureManifest | undefined>;
export function assertPinnedTerminalRuntime(directory: string, generation: string): Promise<TerminalClosureManifest>;
