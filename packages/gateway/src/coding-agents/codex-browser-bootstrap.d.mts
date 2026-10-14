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
