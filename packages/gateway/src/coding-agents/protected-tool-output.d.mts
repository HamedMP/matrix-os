export interface ProtectedToolOutput { version: 1; iv: string; tag: string; data: string }
export function loadToolOutputKey(home: string): Promise<Buffer>;
export function sealToolOutput(key: Buffer, toolCallId: string, text: string): ProtectedToolOutput;
export function openToolOutput(key: Buffer, toolCallId: string, envelope: unknown): string;
