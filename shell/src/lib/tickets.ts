import { getGatewayUrl } from "@/lib/gateway";

const FETCH_TIMEOUT_MS = 10_000;

export interface UnifiedTicket {
  id?: string;
  identifier?: string;
  sourceKind?: "linear" | "matrix";
  title?: string;
  status?: string;
  priority?: string;
  syncStatus?: string;
  revision?: number;
  labelIds?: string[];
  assigneeIds?: string[];
}

export async function listProjectTickets(projectSlug: string): Promise<{ tickets: UnifiedTicket[]; nextCursor: string | null }> {
  const response = await fetch(`${getGatewayUrl()}/api/projects/${encodeURIComponent(projectSlug)}/tickets?source=all&limit=200`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error("Workspace request failed");
  }
  return await response.json() as { tickets: UnifiedTicket[]; nextCursor: string | null };
}
