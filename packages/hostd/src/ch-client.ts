import { isAbsolute } from "node:path";
import { Agent, request } from "undici";

// Client for the Cloud Hypervisor REST API served on a VM's --api-socket.
// Error messages stay generic: callers log `cause` server-side, and neither
// response bodies nor socket paths reach the message.

export type ChVmState = "Created" | "Running" | "Paused" | "Shutdown";

export interface ChVmInfo {
  state: ChVmState;
  memoryActualBytes: number;
}

export type ChErrorCode = "unreachable" | "rejected" | "timeout";

export class ChError extends Error {
  readonly code: ChErrorCode;

  constructor(code: ChErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChError";
    this.code = code;
  }
}

export interface ChClient {
  info(signal: AbortSignal): Promise<ChVmInfo>;
  pause(signal: AbortSignal): Promise<void>;
  resume(signal: AbortSignal): Promise<void>;
  snapshot(destinationDir: string, signal: AbortSignal): Promise<void>;
  resizeMemory(totalBytes: number, signal: AbortSignal): Promise<void>;
  powerButton(signal: AbortSignal): Promise<void>;
  shutdownVmm(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

const VM_STATES: ReadonlySet<string> = new Set<ChVmState>(["Created", "Running", "Paused", "Shutdown"]);
const MAX_RESPONSE_BYTES = 1024 * 1024;
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_DESTROYED",
]);

function errorCode(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

function toChError(error: unknown, signal: AbortSignal): ChError {
  if (error instanceof ChError) return error;
  if (signal.aborted) return new ChError("timeout", "Cloud Hypervisor request timed out", { cause: error });
  const code = errorCode(error);
  if (code !== undefined && UNREACHABLE_CODES.has(code)) {
    return new ChError("unreachable", "Cloud Hypervisor API is unreachable", { cause: error });
  }
  return new ChError("rejected", "Cloud Hypervisor request failed", { cause: error });
}

async function readCapped(body: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > MAX_RESPONSE_BYTES) {
      throw new ChError("rejected", "Cloud Hypervisor response too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseInfo(text: string): ChVmInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new ChError("rejected", "Cloud Hypervisor returned invalid VM info", { cause: error });
    }
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ChError("rejected", "Cloud Hypervisor returned invalid VM info");
  }
  const { state, memory_actual_size: memory } = parsed as { state?: unknown; memory_actual_size?: unknown };
  if (typeof state !== "string" || !VM_STATES.has(state)) {
    throw new ChError("rejected", "Cloud Hypervisor returned invalid VM info");
  }
  if (typeof memory !== "number" || !Number.isSafeInteger(memory) || memory < 0) {
    throw new ChError("rejected", "Cloud Hypervisor returned invalid VM info");
  }
  return { state: state as ChVmState, memoryActualBytes: memory };
}

export function createChClient(socketPath: string): ChClient {
  const agent = new Agent({ connect: { socketPath } });

  async function call(
    method: "GET" | "PUT",
    path: string,
    signal: AbortSignal,
    payload?: Record<string, unknown>,
  ): Promise<string> {
    try {
      const response = await request(`http://localhost/api/v1/${path}`, {
        dispatcher: agent,
        method,
        signal,
        headers: payload === undefined ? undefined : { "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        await response.body.dump();
        throw new ChError("rejected", `Cloud Hypervisor rejected ${path} (status ${response.statusCode})`);
      }
      return await readCapped(response.body);
    } catch (error: unknown) {
      throw toChError(error, signal);
    }
  }

  async function action(path: string, signal: AbortSignal, payload?: Record<string, unknown>): Promise<void> {
    await call("PUT", path, signal, payload);
  }

  return {
    async info(signal) {
      return parseInfo(await call("GET", "vm.info", signal));
    },
    pause: (signal) => action("vm.pause", signal),
    resume: (signal) => action("vm.resume", signal),
    async snapshot(destinationDir, signal) {
      if (!isAbsolute(destinationDir)) throw new RangeError("snapshot destination must be an absolute path");
      await action("vm.snapshot", signal, { destination_url: `file://${destinationDir}` });
    },
    async resizeMemory(totalBytes, signal) {
      if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
        throw new RangeError("memory size must be a positive integer byte count");
      }
      await action("vm.resize", signal, { desired_ram: totalBytes });
    },
    powerButton: (signal) => action("vm.power-button", signal),
    shutdownVmm: (signal) => action("vmm.shutdown", signal),
    close: () => agent.close(),
  };
}
