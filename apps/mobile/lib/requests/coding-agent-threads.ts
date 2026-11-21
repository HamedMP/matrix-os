import { TerminalRefSchema, ThreadIdSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";

import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "@/lib/requests/http";

const THREAD_UNAVAILABLE_ERROR = "Thread unavailable.";

// Only the thread's summary is read. Its events are left unparsed, so an event
// kind newer than this app cannot fail the lookup.
const ThreadTerminalResponseSchema = z.object({
  thread: z.object({ terminalRef: TerminalRefSchema.optional() }),
});

/**
 * The terminal tab a coding-agent thread runs in, named `workspaceId:tabId`
 * as the terminal screen names it, or null when it runs in none.
 */
export async function fetchThreadTerminalSession(
  clerkToken: string,
  computerGatewayUrl: string,
  threadId: string,
  timeoutMs?: number,
): Promise<string | null> {
  const parsedThreadId = ThreadIdSchema.safeParse(threadId);
  if (!parsedThreadId.success) throw new Error(THREAD_UNAVAILABLE_ERROR);
  const { thread } = await fetchAuthenticatedJson({
    url: buildGatewayRequestUrl(computerGatewayUrl, `/api/coding-agents/threads/${encodeURIComponent(parsedThreadId.data)}`),
    token: clerkToken,
    schema: ThreadTerminalResponseSchema,
    errorMessage: THREAD_UNAVAILABLE_ERROR,
    timeoutMs,
  });
  return thread.terminalRef ? `${thread.terminalRef.workspaceId}:${thread.terminalRef.tabId}` : null;
}
