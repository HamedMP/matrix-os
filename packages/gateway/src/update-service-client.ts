import { createConnection } from "node:net";
import { z } from "zod/v4";

export const MAX_UPDATE_SERVICE_FRAME_BYTES = 128 * 1024;
const UPDATE_SERVICE_TIMEOUT_MS = 10_000;
const DEFAULT_UPDATE_SERVICE_SOCKET = "/run/matrix-update-runtime/update.sock";

const UpdateChannelSchema = z.enum(["stable", "canary", "beta", "dev"]);
const UpdateVersionSchema = z.string().regex(
  /^(?:v[0-9]|main-[A-Za-z0-9])[A-Za-z0-9._-]{0,127}$/,
);

const ApplyRequestSchema = z.object({
  schemaVersion: z.literal(1),
  operation: z.literal("Apply"),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("channel"), value: UpdateChannelSchema }).strict(),
    z.object({ kind: z.literal("version"), value: UpdateVersionSchema }).strict(),
  ]),
}).strict();

const NoTargetRequestSchema = z.discriminatedUnion("operation", [
  z.object({ schemaVersion: z.literal(1), operation: z.literal("Repair") }).strict(),
  z.object({ schemaVersion: z.literal(1), operation: z.literal("Rollback") }).strict(),
  z.object({ schemaVersion: z.literal(1), operation: z.literal("Status") }).strict(),
]);

export const UpdateServiceRequestSchema = z.union([
  ApplyRequestSchema,
  NoTargetRequestSchema,
]);
export type UpdateServiceRequest = z.infer<typeof UpdateServiceRequestSchema>;

const GenericUpdateMessageSchema = z.enum([
  "Update accepted",
  "Update service unavailable",
  "Update request rejected",
  "Update operation failed",
]);

const UpdateServiceResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    schemaVersion: z.literal(1),
    ok: z.literal(true),
    status: z.enum(["accepted", "idle", "running"]),
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    ok: z.literal(false),
    code: z.enum(["invalid_request", "busy", "unavailable", "failed"]),
    message: GenericUpdateMessageSchema,
  }).strict(),
]);
export type UpdateServiceResponse = z.infer<typeof UpdateServiceResponseSchema>;

function invalidRequest(): Error {
  return new Error("Invalid update request");
}

function invalidResponse(): Error {
  return new Error("Invalid update response");
}

export function encodeUpdateServiceRequest(input: unknown): Buffer {
  const parsed = UpdateServiceRequestSchema.safeParse(input);
  if (!parsed.success) throw invalidRequest();
  const payload = Buffer.from(JSON.stringify(parsed.data), "utf8");
  if (payload.length === 0 || payload.length > MAX_UPDATE_SERVICE_FRAME_BYTES) {
    throw invalidRequest();
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function decodeUpdateServiceResponse(frame: Buffer): UpdateServiceResponse {
  if (frame.length < 5 || frame.length > MAX_UPDATE_SERVICE_FRAME_BYTES + 4) {
    throw invalidResponse();
  }
  const payloadLength = frame.readUInt32BE(0);
  if (
    payloadLength === 0 ||
    payloadLength > MAX_UPDATE_SERVICE_FRAME_BYTES ||
    payloadLength !== frame.length - 4
  ) {
    throw invalidResponse();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(frame.subarray(4).toString("utf8"));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[update-service] Failed to decode response");
    }
    throw invalidResponse();
  }
  const parsed = UpdateServiceResponseSchema.safeParse(raw);
  if (!parsed.success) throw invalidResponse();
  return parsed.data;
}

export class UpdateServiceUnavailableError extends Error {
  constructor() {
    super("Update service unavailable");
    this.name = "UpdateServiceUnavailableError";
  }
}

export async function requestUpdateService(
  request: UpdateServiceRequest,
  options: {
    socketPath?: string;
    timeoutMs?: number;
  } = {},
): Promise<UpdateServiceResponse> {
  const frame = encodeUpdateServiceRequest(request);
  const socketPath = options.socketPath ??
    process.env.MATRIX_UPDATE_SERVICE_SOCKET ??
    DEFAULT_UPDATE_SERVICE_SOCKET;
  const timeoutMs = options.timeoutMs ?? UPDATE_SERVICE_TIMEOUT_MS;

  return await new Promise<UpdateServiceResponse>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (
      result: { ok: true; value: UpdateServiceResponse } | { ok: false; error: Error },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result.ok) resolve(result.value);
      else reject(result.error);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: new UpdateServiceUnavailableError() });
    }, timeoutMs);
    timer.unref();

    socket.once("connect", () => {
      socket.write(frame);
    });
    socket.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_UPDATE_SERVICE_FRAME_BYTES + 4) {
        finish({ ok: false, error: invalidResponse() });
        return;
      }
      chunks.push(chunk);
      if (totalBytes < 4) return;
      const response = Buffer.concat(chunks, totalBytes);
      const expectedBytes = response.readUInt32BE(0) + 4;
      if (expectedBytes > MAX_UPDATE_SERVICE_FRAME_BYTES + 4) {
        finish({ ok: false, error: invalidResponse() });
        return;
      }
      if (totalBytes === expectedBytes) {
        try {
          finish({ ok: true, value: decodeUpdateServiceResponse(response) });
        } catch (error: unknown) {
          finish({
            ok: false,
            error: error instanceof Error ? error : invalidResponse(),
          });
        }
      } else if (totalBytes > expectedBytes) {
        finish({ ok: false, error: invalidResponse() });
      }
    });
    socket.once("error", () => {
      finish({ ok: false, error: new UpdateServiceUnavailableError() });
    });
    socket.once("end", () => {
      if (!settled) {
        finish({ ok: false, error: new UpdateServiceUnavailableError() });
      }
    });
  });
}
