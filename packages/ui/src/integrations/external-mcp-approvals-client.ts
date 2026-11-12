/**
 * Contract and transport for owner approvals of external Matrix Core MCP
 * writes (spec 2691, layer 7). The owner route returns approval id, service,
 * tool, and times only: never tool arguments or the client's name.
 */
import { z } from "zod/v4";

export const ExternalMcpApprovalSchema = z.strictObject({
  approvalId: z.uuid(),
  service: z.string().min(1).max(64).nullable(),
  tool: z.string().min(1).max(200),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export const ExternalMcpApprovalListSchema = z.strictObject({ approvals: z.array(ExternalMcpApprovalSchema).max(50) });
export const ExternalMcpDecisionResultSchema = z.strictObject({ status: z.enum(["approved", "denied"]) });
export type ExternalMcpApproval = z.infer<typeof ExternalMcpApprovalSchema>;
export type ExternalMcpDecision = "approve" | "decline";

export interface ExternalMcpApprovalsTransport {
  list(): Promise<unknown>;
  decide(approvalId: string, decision: ExternalMcpDecision): Promise<unknown>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
export const EXTERNAL_MCP_APPROVALS_MIN_POLL_MS = 15_000;
export const EXTERNAL_MCP_APPROVALS_DEFAULT_POLL_MS = 30_000;
export const EXTERNAL_MCP_APPROVALS_LOAD_ERROR = "Approvals are unavailable right now. Try again.";
export const EXTERNAL_MCP_APPROVALS_SAVE_ERROR = "That decision couldn’t be saved. Try again.";
const CONFLICT_ERROR = "This request expired or was already decided. Refresh to see the current list.";

/** Only fixed copy; a 409 (expired, decided elsewhere, or policy changed) gets its own line. */
export function externalMcpApprovalErrorMessage(error: unknown): string {
  const status = error && typeof error === "object"
    ? (error as { httpStatus?: unknown; status?: unknown }).httpStatus ?? (error as { status?: unknown }).status : undefined;
  return status === 409 ? CONFLICT_ERROR : EXTERNAL_MCP_APPROVALS_SAVE_ERROR;
}

/** Streams the body, cancelling the read as soon as it passes the cap; never buffers an oversized body. */
async function readBoundedText(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length") ?? "0") > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("ExternalMcpApprovalsUnavailable");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("ExternalMcpApprovalsUnavailable");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/** Fetch transport for the platform-owned owner routes; `baseUrl` is the app origin, never a `/vm/<handle>` gateway prefix. */
export function createExternalMcpApprovalsFetchTransport(options: { baseUrl: string; fetchImpl?: typeof fetch }): ExternalMcpApprovalsTransport {
  const base = `${options.baseUrl.replace(/\/$/, "")}/api/mcp-servers/core/external-approvals`;
  const request = async (url: string, init: RequestInit): Promise<unknown> => {
    const response = await (options.fetchImpl ?? fetch)(url, { ...init, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) {
      await response.body?.cancel();
      throw Object.assign(new Error("ExternalMcpApprovalsUnavailable"), { httpStatus: response.status });
    }
    return JSON.parse(await readBoundedText(response)) as unknown;
  };
  return {
    list: () => request(base, { method: "GET", headers: { accept: "application/json" } }),
    decide: (approvalId, decision) => {
      if (!z.uuid().safeParse(approvalId).success) return Promise.reject(new Error("ExternalMcpApprovalsUnavailable"));
      return request(`${base}/${approvalId}`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ decision }) });
    },
  };
}

