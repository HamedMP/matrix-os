import { previewDriveActionCanonical } from "@matrix-os/contracts";
import { z } from "zod/v4";

const Hex = z.string().regex(/^[a-f0-9]{64}$/);
const Ref = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const Handle = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const Scope = z.strictObject({ runGrant: Hex, chatId: Ref, runId: Ref });
const Action = z.strictObject({ service: z.literal("google_drive"), action: z.literal("list_files"),
  label: z.string().trim().min(1).max(100), params: z.strictObject({ maxResults: z.number().int().min(1).max(3) }) });
const Turn = z.strictObject({ actorId: Ref, chatId: Ref, turnId: Ref, runId: Ref,
  clientRequestId: Ref, bodyDigest: Hex, proof: z.string().min(1).max(2_000) });
const Grant = Scope.extend({ approvalId: Ref, clientRequestId: Ref, actionDigest: Hex, action: Action,
  proof: z.string().min(1).max(2_000) });
const Execute = Scope.extend({ actionGrant: Hex, action: Action });
// Match the Platform metadata projector exactly; it strips every other provider field.
const File = z.strictObject({ id: z.string().min(1).max(256), name: z.string().min(1).max(1_024),
  mimeType: z.string().max(2_000).optional(), modifiedTime: z.string().max(2_000).optional(),
  size: z.string().max(2_000).optional(), webViewLink: z.string().max(2_000).optional() });
const Result = z.strictObject({ service: z.literal("google_drive"), action: z.literal("list_files"),
  data: z.strictObject({ files: z.array(File).max(3) }) });

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.ok) throw new Error("Preview Drive Platform unavailable");
  if (!response.body) throw new Error("Preview Drive Platform unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw new Error("Preview Drive Platform response too large");
      chunks.push(part.value);
    }
  } finally {
    try { await reader.cancel(); }
    catch (error: unknown) {
      console.warn("[preview-drive] Platform response cleanup failed", error instanceof Error ? error.name : "UnknownError");
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** The VPS machine token is only transport authentication; Platform also verifies browser proofs and grants. */
export function createPreviewDrivePlatformClient(options: {
  platformUrl: string; handle: string; machineToken: string; fetcher?: typeof fetch;
}) {
  const base = new URL(options.platformUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || !options.machineToken) throw new Error("Preview Drive Platform client unavailable");
  const endpoint = new URL(`/internal/containers/${Handle.parse(options.handle)}/preview-drive/`, base);
  const fetcher = options.fetcher ?? fetch;

  async function post(path: string, body: unknown, proof?: { header: string; value: string }, limit = 64 * 1024) {
    const response = await fetcher(new URL(path, endpoint).toString(), { method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${options.machineToken}`, "content-type": "application/json",
        ...(proof ? { [proof.header]: proof.value } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return boundedJson(response, limit);
  }
  return {
    async redeemTurn(input: z.infer<typeof Turn>): Promise<string> {
      const parsed = Turn.parse(input);
      const { proof, ...body } = parsed;
      const result = await post("turn/redeem", body, { header: "x-matrix-preview-drive-turn-proof", value: proof }, 2_048);
      return z.strictObject({ runGrant: Hex }).parse(result).runGrant;
    },
    async discover(input: z.infer<typeof Scope> & { kind: "inventory" | "catalog" }): Promise<unknown> {
      const parsed = Scope.extend({ kind: z.enum(["inventory", "catalog"]) }).parse(input);
      const result = await post("discover", parsed);
      if (!Array.isArray(result) || result.length > 16) throw new Error("Preview Drive discovery unavailable");
      return result;
    },
    async grantAction(input: z.infer<typeof Grant>): Promise<string> {
      const parsed = Grant.parse(input);
      if (!previewDriveActionCanonical(parsed.action)) throw new Error("Invalid Preview Drive action");
      const { proof, ...body } = parsed;
      const result = await post("grants", body, { header: "x-matrix-custom-mcp-approval-proof", value: proof }, 2_048);
      return z.strictObject({ actionGrant: Hex }).parse(result).actionGrant;
    },
    async execute(input: z.infer<typeof Execute>): Promise<z.infer<typeof Result>> {
      const parsed = Execute.parse(input);
      if (!previewDriveActionCanonical(parsed.action)) throw new Error("Invalid Preview Drive action");
      return Result.parse(await post("execute", parsed, undefined, 32 * 1024));
    },
    async revoke(input: z.infer<typeof Scope>): Promise<void> {
      await post("revoke", Scope.parse(input), undefined, 2_048);
    },
  };
}

export type PreviewDrivePlatformClient = ReturnType<typeof createPreviewDrivePlatformClient>;
