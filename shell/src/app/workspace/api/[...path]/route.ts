import { readSharedBundledAsset } from "../../bundled-assets";
import { sharedShellOrigin, sharedWorkspaceAccess, sharedWorkerTarget } from "../../access";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function boundedBody(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | undefined> {
  if (!stream) return undefined;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new RangeError("Body limit exceeded"); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}

async function forward(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const access = await sharedWorkspaceAccess(request.headers);
  if (access.status !== 200) return Response.json({ error: "Workspace access unavailable" }, { status: access.status });
  const mutating = !["GET", "HEAD"].includes(request.method);
  const origin = request.headers.get("origin");
  let shellOrigin: string;
  try { shellOrigin = sharedShellOrigin(request.url); }
  catch (error: unknown) {
    console.warn("[workspace] Shell origin unavailable", error instanceof Error ? error.name : "UnknownError");
    return Response.json({ error: "Workspace service unavailable" }, { status: 503 });
  }
  // Browser cookie mutations must originate in this preview. Isolated bearer
  // automation can omit Origin, but never supply a foreign one.
  if (mutating && ((origin && origin !== shellOrigin) || (!origin && !request.headers.get("authorization")))) {
    return Response.json({ error: "Request rejected" }, { status: 403 });
  }
  const { path } = await context.params;
  if (path[0] === "ws") return Response.json({ error: "Live connection unavailable in this preview" }, { status: 503 });
  let target: URL;
  try { target = sharedWorkerTarget(path, new URL(request.url).search); }
  catch (error: unknown) {
    console.warn("[workspace] Invalid shared target", error instanceof Error ? error.name : "UnknownError");
    return Response.json({ error: "Workspace service unavailable" }, { status: 503 });
  }
  try {
    const body = mutating ? await boundedBody(request.body, MAX_BODY_BYTES) : undefined;
    const headers = new Headers({ Authorization: `Bearer ${access.token}` });
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    const response = await fetch(target, { method: request.method, headers, body: body as BodyInit | undefined, signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!mutating && response.status === 404) {
      const asset = await readSharedBundledAsset(path, new URL(request.url).searchParams);
      if (asset) {
        await response.body?.cancel();
        return request.method === "HEAD" ? new Response(null, { status: 200, headers: asset.headers }) : asset;
      }
    }
    const data = request.method === "HEAD" ? null : await boundedBody(response.body, MAX_RESPONSE_BYTES);
    const responseHeaders = new Headers({ "Cache-Control": "private, no-store" });
    const responseType = response.headers.get("content-type");
    if (responseType) responseHeaders.set("content-type", responseType);
    return new Response(data as BodyInit | null, { status: response.status, headers: responseHeaders });
  } catch (error: unknown) {
    console.warn("[workspace] Shared request failed", error instanceof Error ? error.name : "UnknownError");
    return Response.json({ error: "Workspace request unavailable" }, { status: error instanceof RangeError ? 413 : 503 });
  }
}
export { forward as GET, forward as HEAD, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
