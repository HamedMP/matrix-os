export function codexToolOutput(item: Record<string, unknown>, privateContext?: boolean, protection?: { key: Buffer; toolCallId: string }): { text: string; truncated: boolean; protectedOutput?: import("./protected-tool-output.mjs").ProtectedToolOutput } | undefined;
export function codexToolHasPrivateContext(item: Record<string, unknown>): boolean;

export function coarseToolOutputText(text: string): string;

export function safeCodexSubagentText(value: unknown, limit: number): string | undefined;
