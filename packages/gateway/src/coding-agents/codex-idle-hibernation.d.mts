import type { z } from "zod/v4";
export const CodexHibernateControlSchema: z.ZodObject<{
  type: z.ZodLiteral<"hibernate">;
  providerThreadId: z.ZodString;
  clientRequestId: z.ZodString;
}>;
export function createCodexIdleHibernation(readState: () => {
  providerThreadId?: string;
  completedTurns: number;
  active: boolean;
  pending: number;
  otherControls: boolean;
}): { readonly closing: boolean; prepare(providerThreadId: string): boolean };
