import { z } from "zod/v4";

/** MCP progress is service-provided status text, not an implicit stdout contract. */
export const McpToolProgressSchema = z.object({
  progress: z.number().finite().nonnegative(),
  total: z.number().finite().nonnegative().optional(),
  message: z.string().max(3000).optional(),
});
export type McpToolProgress = z.infer<typeof McpToolProgressSchema>;
export type McpProgressListener = (progress: McpToolProgress) => void;
export const MCP_TOOL_STREAM_TYPE = "application/x-matrix-tool-stream+ndjson";
export const MCP_TOOL_RESULT_MAX_BYTES = 192 * 1024;
// JSON escaping can use six bytes per message code unit; allow three bounded frames.
export const MCP_TOOL_STREAM_MAX_BYTES = MCP_TOOL_RESULT_MAX_BYTES + 3 * 24 * 1024 + 512;
export const McpToolStreamFrameSchema = z.discriminatedUnion("type", [
  McpToolProgressSchema.extend({ type: z.literal("progress") }),
  z.object({ type: z.literal("result"), result: z.unknown() }),
  z.object({ type: z.literal("error") }),
]);
