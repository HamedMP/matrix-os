import { z } from "zod/v4";
import { UploadRateLimiter } from "./bounded.js";
import { GitHubAuthorizer, REPO_PATTERN } from "./github.js";
import { createEvidenceKey, parseEvidenceKey } from "./keys.js";
import { isMediaType, MAX_FILE_BYTES, MAX_FILES_PER_REQUEST, MEDIA_TYPES, type MediaType } from "./media.js";
import { MIN_TICKET_SECRET_LENGTH, signUploadTicket, TICKET_TTL_MS, verifyUploadTicket } from "./ticket.js";

export { MAX_FILE_BYTES, MAX_FILES_PER_REQUEST } from "./media.js";
export { TICKET_TTL_MS } from "./ticket.js";

export const UPLOAD_REQUEST_BODY_LIMIT = 16 * 1024;
export const DEFAULT_REPO = "HamedMP/matrix-os";
export const DEFAULT_PUBLIC_ORIGIN = "https://evidence.matrix-os.com";
const UPLOADS_PATH = "/uploads";
const UPLOAD_PATH_PREFIX = "/uploads/";
export const SERVED_CSP = "default-src 'none'; sandbox";

export interface EvidenceEnv {
  EVIDENCE?: R2Bucket;
  UPLOAD_TICKET_SECRET?: string;
  GITHUB_REPO?: string;
  PUBLIC_ORIGIN?: string;
}

export interface EvidenceWorkerDeps {
  authorizerFor: (repo: string) => Pick<GitHubAuthorizer, "authorize">;
  limiter: Pick<UploadRateLimiter, "tryConsume">;
  now: () => number;
}

const UploadRequestSchema = z.object({
  pr: z.number().int().min(1).max(999_999_999),
  commit: z.string().regex(/^[0-9a-fA-F]{7,40}$/),
  files: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        contentType: z.string().refine(isMediaType),
        size: z.number().int().min(1).max(MAX_FILE_BYTES),
      }),
    )
    .min(1)
    .max(MAX_FILES_PER_REQUEST),
});

export function createEvidenceWorker(deps: EvidenceWorkerDeps) {
  return async function handle(request: Request, env: EvidenceEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === UPLOADS_PATH) {
        if (request.method !== "POST") return jsonError(405, "method_not_allowed", { Allow: "POST" });
        return await handleCreateUploads(request, env, deps);
      }
      if (path.startsWith(UPLOAD_PATH_PREFIX)) {
        if (request.method !== "PUT") return jsonError(405, "method_not_allowed", { Allow: "PUT" });
        return await handlePutUpload(request, env, deps, path.slice(UPLOAD_PATH_PREFIX.length));
      }
      if (request.method === "GET" || request.method === "HEAD") {
        return await handleGet(request, env, path.slice(1));
      }
      return jsonError(404, "not_found");
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      console.error("[pr-evidence] unhandled_error", { error: name });
      return jsonError(500, "internal_error");
    }
  };
}

async function handleCreateUploads(request: Request, env: EvidenceEnv, deps: EvidenceWorkerDeps): Promise<Response> {
  const secret = ticketSecret(env);
  const repo = env.GITHUB_REPO ?? DEFAULT_REPO;
  if (!secret || !env.EVIDENCE || !REPO_PATTERN.test(repo)) {
    console.error("[pr-evidence] misconfigured", { secret: Boolean(secret), bucket: Boolean(env.EVIDENCE) });
    return jsonError(503, "service_unavailable");
  }
  const token = bearerToken(request);
  if (!token) return jsonError(401, "unauthorized", { "WWW-Authenticate": "Bearer" });

  const text = await readLimitedText(request, UPLOAD_REQUEST_BODY_LIMIT);
  if (text === null) return jsonError(413, "payload_too_large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return jsonError(400, "invalid_request");
    throw error;
  }
  const parsed = UploadRequestSchema.safeParse(raw);
  if (!parsed.success) return jsonError(400, "invalid_request");
  const { pr, commit, files } = parsed.data;

  const decision = await deps.authorizerFor(repo).authorize(token, pr);
  if (!decision.ok) return jsonError(decision.status, decision.error);
  if (!deps.limiter.tryConsume(decision.login, files.length)) {
    return jsonError(429, "rate_limited", { "Retry-After": "3600" });
  }

  const origin = publicOrigin(env);
  const expiresAt = deps.now() + TICKET_TTL_MS;
  const issued = await Promise.all(
    files.map(async (file) => {
      const contentType = file.contentType as MediaType;
      const key = createEvidenceKey(pr, commit, contentType);
      const ticket = await signUploadTicket(secret, { key, contentType, size: file.size, expiresAt, login: decision.login });
      return {
        name: file.name,
        key,
        contentType,
        size: file.size,
        url: `${origin}/${key}`,
        uploadUrl: `${origin}${UPLOAD_PATH_PREFIX}${key}?t=${ticket}`,
        ticket,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    }),
  );
  console.info("[pr-evidence] uploads_issued", { login: decision.login, pr, files: issued.length });
  return json(200, { files: issued });
}

async function handlePutUpload(
  request: Request,
  env: EvidenceEnv,
  deps: EvidenceWorkerDeps,
  key: string,
): Promise<Response> {
  const secret = ticketSecret(env);
  const bucket = env.EVIDENCE;
  if (!secret || !bucket) {
    console.error("[pr-evidence] misconfigured", { secret: Boolean(secret), bucket: Boolean(bucket) });
    return jsonError(503, "service_unavailable");
  }
  // The ticket rides in `?t=` (returned uploadUrl) or, equivalently, as a Bearer header.
  const token = new URL(request.url).searchParams.get("t") ?? bearerToken(request);
  if (!token) return jsonError(401, "unauthorized");
  const ticket = await verifyUploadTicket(secret, token, deps.now());
  if (!ticket || ticket.key !== key || !parseEvidenceKey(key)) return jsonError(403, "invalid_ticket");

  const contentType = (request.headers.get("content-type") ?? "").trim().toLowerCase();
  if (contentType !== ticket.contentType) return jsonError(415, "content_type_mismatch");
  const declaredLength = Number(request.headers.get("content-length"));
  if (!Number.isInteger(declaredLength) || declaredLength !== ticket.size) {
    return jsonError(411, "content_length_mismatch");
  }
  if (!request.body) return jsonError(400, "empty_body");

  if (await bucket.head(key)) return jsonError(409, "already_uploaded");

  const sized = enforceExactSize(request.body, ticket.size);
  let stored: R2Object | null;
  try {
    // `If-None-Match: *` makes the write conditional on the key not existing (no overwrite/reuse).
    stored = await bucket.put(key, sized.stream, {
      httpMetadata: { contentType: ticket.contentType },
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
  } catch (error) {
    if (sized.mismatch()) return jsonError(400, "content_length_mismatch");
    const name = error instanceof Error ? error.name : "unknown";
    console.error("[pr-evidence] r2_put_failed", { error: name });
    return jsonError(503, "storage_unavailable");
  }
  if (sized.mismatch()) {
    await bucket.delete(key);
    return jsonError(400, "content_length_mismatch");
  }
  if (!stored) return jsonError(409, "already_uploaded");
  console.info("[pr-evidence] upload_stored", { login: ticket.login, size: ticket.size });
  return json(201, { key, url: `${publicOrigin(env)}/${key}` });
}

async function handleGet(request: Request, env: EvidenceEnv, key: string): Promise<Response> {
  const parsed = parseEvidenceKey(key);
  if (!parsed || !env.EVIDENCE) {
    if (!env.EVIDENCE) console.error("[pr-evidence] misconfigured", { bucket: false });
    return notFound();
  }
  const rangeRequested = request.headers.has("range");
  let object: R2ObjectBody | R2Object | null;
  try {
    object =
      request.method === "HEAD"
        ? await env.EVIDENCE.head(key)
        : await env.EVIDENCE.get(key, rangeRequested ? { range: request.headers } : undefined);
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    console.error("[pr-evidence] r2_get_failed", { error: name });
    return jsonError(503, "storage_unavailable");
  }
  if (!object) return notFound();

  const headers = servedHeaders(parsed.contentType);
  headers.set("ETag", object.httpEtag);
  let status = 200;
  let length = object.size;
  if (rangeRequested && object.range && "body" in object) {
    const range = object.range as { offset?: number; length?: number; suffix?: number };
    const offset = range.suffix !== undefined ? Math.max(0, object.size - range.suffix) : (range.offset ?? 0);
    length = range.suffix !== undefined ? object.size - offset : (range.length ?? object.size - offset);
    status = 206;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
  }
  headers.set("Content-Length", String(length));
  const body = request.method === "HEAD" || !("body" in object) ? null : (object as R2ObjectBody).body;
  return new Response(body, { status, headers });
}

export function servedHeaders(contentType: MediaType): Headers {
  return new Headers({
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Disposition": "inline",
    "Content-Security-Policy": SERVED_CSP,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Referrer-Policy": "no-referrer",
    "Accept-Ranges": "bytes",
  });
}

/** Passes bytes through while counting; errors the stream when the body is longer or shorter than `size`. */
export function enforceExactSize(
  body: ReadableStream<Uint8Array>,
  size: number,
): { stream: ReadableStream<Uint8Array>; mismatch: () => boolean } {
  let total = 0;
  let mismatch = false;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > size) {
        mismatch = true;
        controller.error(new RangeError("upload exceeds declared size"));
        return;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (total !== size) {
        mismatch = true;
        controller.error(new RangeError("upload shorter than declared size"));
      }
    },
  });
  let stream = body.pipeThrough(counter);
  // Workers R2 needs a known-length stream; FixedLengthStream is Workers-only.
  const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array> })
    .FixedLengthStream;
  if (Fixed) stream = stream.pipeThrough(new Fixed(size));
  return { stream, mismatch: () => mismatch };
}

export async function readLimitedText(request: Request, limit: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer ([^\s]{1,2048})$/.exec(header.trim());
  return match ? match[1]! : null;
}

function ticketSecret(env: EvidenceEnv): string | null {
  const secret = env.UPLOAD_TICKET_SECRET?.trim();
  return secret && secret.length >= MIN_TICKET_SECRET_LENGTH ? secret : null;
}

function publicOrigin(env: EvidenceEnv): string {
  const configured = env.PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
        return parsed.origin;
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    console.error("[pr-evidence] invalid_public_origin");
  }
  return DEFAULT_PUBLIC_ORIGIN;
}

function json(status: number, body: unknown, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
  });
}

function jsonError(status: number, error: string, extra?: Record<string, string>): Response {
  return json(status, { error }, extra);
}

function notFound(): Response {
  return jsonError(404, "not_found");
}

const authorizers = new Map<string, GitHubAuthorizer>();
const defaultLimiter = new UploadRateLimiter();

const defaultHandler = createEvidenceWorker({
  authorizerFor(repo) {
    let authorizer = authorizers.get(repo);
    if (!authorizer) {
      // One configured repo per deployment; cap defensively anyway.
      if (authorizers.size >= 4) authorizers.clear();
      authorizer = new GitHubAuthorizer({ repo });
      authorizers.set(repo, authorizer);
    }
    return authorizer;
  },
  limiter: defaultLimiter,
  now: Date.now,
});

export const ALLOWED_MEDIA_TYPES = Object.keys(MEDIA_TYPES) as MediaType[];

const worker = {
  fetch: defaultHandler,
};

export default worker;
