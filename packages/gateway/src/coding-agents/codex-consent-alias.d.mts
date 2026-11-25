export const CODEX_CONSENT_ALIAS_PATH: string;
export type CodexConsentAlias = { version: 1; saved: string; durable: string };
export const CodexConsentAliasSchema: import("zod/v4").ZodType<CodexConsentAlias>;
export function readCodexConsentAlias(homePath: string): Promise<CodexConsentAlias | null>;
export function savedCodexConsentMatches(saved: string | null | undefined, current: string | null | undefined, alias: CodexConsentAlias | null | undefined, legacy?: string | null): boolean;
