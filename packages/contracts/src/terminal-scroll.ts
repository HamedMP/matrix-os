import { z } from "zod/v4";
export const TerminalScrollLineSchema = z.number().int().min(0).max(100_000);
export const TerminalScrollStateSchema = z.object({
  above: TerminalScrollLineSchema,
  below: TerminalScrollLineSchema,
  rows: z.number().int().min(1).max(200),
}).strict().refine((state) => state.above + state.below <= 100_000);
export type TerminalScrollState = z.infer<typeof TerminalScrollStateSchema>;
