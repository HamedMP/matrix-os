export function codexToolOutput(item: Record<string, unknown>, privateContext?: boolean): { text: string; truncated: boolean } | undefined;
export function codexToolHasPrivateContext(item: Record<string, unknown>): boolean;
