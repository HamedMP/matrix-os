import type { z } from "zod/v4";
export const CodexBrowserLeaseSchema: z.ZodObject<{
  attemptId: z.ZodString; token: z.ZodString; gatewayPort: z.ZodNumber;
}>;
export const CodexBrowserBindSchema: z.ZodObject<{
  attemptId: z.ZodString; token: z.ZodString; gatewayPort: z.ZodNumber;
  type: z.ZodLiteral<"browser_bind">; clientRequestId: z.ZodString;
}>;
export const CodexBrowserStartSchema: z.ZodObject<{
  type: z.ZodLiteral<"browser_start">; attemptId: z.ZodString; clientRequestId: z.ZodString;
}>;
export type CodexBrowserLease = { attemptId: string; token: string; gatewayPort: number };
export const CODEX_BROWSER_INSTRUCTIONS: string;
export function codexBrowserThreadConfig(lease: CodexBrowserLease | undefined, options?: { tokenFile?: boolean }): Record<string, Record<string, unknown>>;
export function codexBrowserChildEnvironment(environment: Record<string, string | undefined>, lease: CodexBrowserLease | undefined, tokenFilePath?: string): Record<string, string | undefined>;
export interface CodexBrowserTokenFile { path: string; write(token: string): Promise<void>; clear(): Promise<void>; close(): Promise<void> }
export function createCodexBrowserTokenFile(enabled: boolean): Promise<CodexBrowserTokenFile | undefined>;
export function canRenewCodexBrowserInPlace(current: CodexBrowserLease | undefined, next: CodexBrowserLease | undefined, tokenFile: CodexBrowserTokenFile | undefined): boolean;
export function createCodexBrowserBootstrap(attemptId?: string): {
  bind(raw: unknown): Promise<boolean>; waitLease(signal: AbortSignal): Promise<CodexBrowserLease | undefined>;
  markReady(): void; release(id: string): boolean; waitRelease(signal: AbortSignal): Promise<void>; fail(): void;
};
export function sweepCodexBrowserTokenDirs(options?: { root?: string; now?: number; minAgeMs?: number; isAlive?: (pid: number) => boolean }): Promise<number>;
