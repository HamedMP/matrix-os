/**
 * `matrix mcp bridge` (spec 2691): stdio <-> the hosted Matrix `/mcp` for
 * MCP clients that only speak stdio. A transport-level proxy: JSON-RPC
 * messages pass through unchanged; the bridge adds only the profile's `/mcp`
 * OAuth bearer, bounded frames, and timeouts. stdout carries protocol only.
 */
import { Transform, type Readable, type Writable } from "node:stream";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createRemoteMcpTokenSource, trustedUrl } from "./remote-oauth.js";

/** Matches the platform `/mcp` request body limit. */
export const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;
/** Above the platform's 55 s request budget; responses beyond it are abandoned. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Hosted Core results are capped at 1 MiB plus a JSON-RPC envelope. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class BridgeFrameError extends Error {
  constructor() {
    super("Matrix MCP bridge frame exceeds the size limit");
    this.name = "BridgeFrameError";
  }
}

/** Fails the stream once one newline-delimited frame exceeds the limit. */
function boundedLines(maxFrameBytes: number): Transform {
  let pending = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      let start = 0;
      for (let index = chunk.indexOf(0x0a); index >= 0; index = chunk.indexOf(0x0a, start)) {
        if (pending + index - start > maxFrameBytes) return callback(new BridgeFrameError());
        pending = 0;
        start = index + 1;
      }
      pending += chunk.length - start;
      if (pending > maxFrameBytes) return callback(new BridgeFrameError());
      callback(null, chunk);
    },
  });
}

function boundedBody(response: Response): Response {
  if (!response.body) return response;
  let seen = 0;
  const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > MAX_RESPONSE_BYTES) controller.error(new BridgeFrameError());
      else controller.enqueue(chunk);
    },
  }));
  return new Response(limited, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function requestId(message: JSONRPCMessage): string | number | undefined {
  return "method" in message && "id" in message ? (message as { id: string | number }).id : undefined;
}

export async function runRemoteMcpBridge(options: {
  profileName: string; configDir?: string; stdin?: Readable; stdout?: Writable;
  fetch?: typeof fetch; maxFrameBytes?: number;
}): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const tokens = createRemoteMcpTokenSource({ profileName: options.profileName, configDir: options.configDir, fetch: fetchImpl });
  const resource = trustedUrl((await tokens.load()).resource);
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;

  const authorizedFetch: typeof fetch = async (input, init) => {
    const send = async (token: string) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return fetchImpl(input, { ...init, headers, redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(init?.signal ? [init.signal] : [])]) });
    };
    const token = await tokens.accessToken();
    let response = await send(token);
    if (response.status === 401) {
      await response.body?.cancel();
      response = await send(await tokens.afterRejected(token));
    }
    return boundedBody(response);
  };

  const input = (options.stdin ?? process.stdin).pipe(boundedLines(maxFrameBytes));
  const stdio = new StdioServerTransport(input, options.stdout ?? process.stdout);
  const remote = new StreamableHTTPClientTransport(resource, { fetch: authorizedFetch });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      void Promise.allSettled([remote.close(), stdio.close()]).then(() => error ? reject(error) : resolve());
    };
    input.once("error", error => finish(error));
    input.once("end", () => finish());
    remote.onmessage = message => { void stdio.send(message).catch(finish); };
    remote.onerror = error => console.error("Matrix MCP bridge request failed.", error instanceof Error ? error.name : "UnknownError");
    stdio.onerror = error => finish(error);
    stdio.onmessage = message => {
      void remote.send(message).catch((error: unknown) => {
        // Never echo upstream or OAuth detail into the protocol stream.
        console.error("Matrix MCP bridge request failed.", error instanceof Error ? error.name : "UnknownError");
        const id = requestId(message);
        if (id !== undefined) {
          void stdio.send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Matrix MCP is unavailable. Run `matrix mcp login` if this persists." } })
            .catch(finish);
        }
      });
    };
    void Promise.all([remote.start(), stdio.start()]).catch(finish);
  });
}
