import { z } from "zod/v4";

const UUID = z.uuid();
const RunId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const PrepareResponse = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("allow") }).strict(),
  z.object({ kind: z.literal("pending"), approvalId: UUID, expiresAt: z.iso.datetime() }).strict(),
]);
const DecisionResponse = z.object({ receipt: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();

export interface CustomMcpApprovalClient {
  registerRun(runId: string): Promise<boolean>;
  prepare(runId: string, input: {
    nativeRequestId: string;
    serverId: string;
    tool: string;
    arguments?: Record<string, unknown>;
  }): Promise<z.infer<typeof PrepareResponse>>;
  decide(runId: string, approvalId: string, decision: "approve" | "decline" | "cancel", provenance?: {
    chatId: string; clientRequestId: string; platformApprovalProof: string;
  }):
    Promise<z.infer<typeof DecisionResponse>>;
  revokeRun(runId: string): Promise<boolean>;
}

export function createCustomMcpApprovalClient(options: {
  platformUrl: string;
  handle: string;
  token: string;
  fetcher?: typeof fetch;
}): CustomMcpApprovalClient {
  const base = new URL(options.platformUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password
    || base.search || base.hash || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.handle)
    || !options.token) throw new Error("Custom MCP approval client unavailable");
  const endpoint = new URL(`/internal/containers/${options.handle}/mcp-approvals/`, base);
  const fetcher = options.fetcher ?? fetch;

  async function post(path: string, value: unknown, proof?: string): Promise<Response> {
    const response = await fetcher(new URL(path, endpoint).toString(), {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json",
        ...(proof ? { "x-matrix-custom-mcp-approval-proof": proof } : {}) },
      body: JSON.stringify(value), redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Custom MCP approval unavailable");
    return response;
  }

  return {
    async registerRun(runId) {
      const id = RunId.parse(runId);
      const result = await post("runs", { runId: id });
      return z.object({ registered: z.literal(true) }).strict().parse(await result.json()).registered;
    },
    async prepare(runId, input) {
      const id = RunId.parse(runId);
      const result = await post(`runs/${encodeURIComponent(id)}/prepare`, input);
      return PrepareResponse.parse(await result.json());
    },
    async decide(runId, approvalId, decision, provenance) {
      const id = RunId.parse(runId);
      const approval = UUID.parse(approvalId);
      const result = await post(`runs/${encodeURIComponent(id)}/decisions/${approval}`, {
        decision, ...(provenance ? { chatId: provenance.chatId, clientRequestId: provenance.clientRequestId } : {}),
      }, provenance?.platformApprovalProof);
      return DecisionResponse.parse(await result.json());
    },
    async revokeRun(runId) {
      const id = RunId.parse(runId);
      const result = await post(`runs/${encodeURIComponent(id)}/revoke`, {});
      return z.object({ revoked: z.literal(true) }).strict().parse(await result.json()).revoked;
    },
  };
}
