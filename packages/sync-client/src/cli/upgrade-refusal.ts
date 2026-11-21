import {
  classifyRuntimeWakeText,
  MAX_RUNTIME_WAKE_BODY_CHARS,
  type RuntimeWakeSignal,
} from "@matrix-os/contracts/runtime-wake";

/**
 * Refused websocket upgrades. The `ws` package emits `unexpected-response`
 * with the request and response when an upgrade is answered without a 101;
 * a 503 wake response there means the Matrix computer is still waking
 * (spec 2691, ENG-520).
 */

const UPGRADE_REFUSAL_READ_TIMEOUT_MS = 2_000;

interface UpgradeRefusal {
  status: number;
  retryAfter: string | null;
  body: string;
}

interface UpgradeRefusalMessage {
  statusCode?: unknown;
  headers?: Record<string, unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  resume?: () => unknown;
}

export function ignoreAbandonedSocketError(err: unknown): void {
  console.warn("[shell] abandoned attach socket reported an error", err instanceof Error ? err.name : "unknown_error");
}

function destroyUpgradeRequest(req: unknown): void {
  if (req && typeof req === "object" && typeof (req as { destroy?: unknown }).destroy === "function") {
    (req as { destroy: () => void }).destroy();
  }
}

/** Reads the status, Retry-After, and a bounded body of a refused websocket upgrade. */
function readUpgradeRefusal(res: unknown): Promise<UpgradeRefusal | null> {
  if (!res || typeof res !== "object") return Promise.resolve(null);
  const message = res as UpgradeRefusalMessage;
  const status = typeof message.statusCode === "number" ? message.statusCode : 0;
  const header = message.headers?.["retry-after"];
  const retryAfter = typeof header === "string" ? header : null;
  if (status !== 503 || typeof message.on !== "function") {
    message.resume?.();
    return Promise.resolve({ status, retryAfter, body: "" });
  }
  const on = message.on.bind(message);
  return new Promise((resolve) => {
    let body = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, retryAfter, body });
    };
    const timer = setTimeout(finish, UPGRADE_REFUSAL_READ_TIMEOUT_MS);
    timer.unref?.();
    on("data", (chunk: unknown) => {
      if (done) return;
      body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      // Past the cap it cannot be a wake response; stop reading.
      if (body.length > MAX_RUNTIME_WAKE_BODY_CHARS) finish();
    });
    on("end", finish);
    on("error", (err: unknown) => {
      console.warn("[shell] refused upgrade body unreadable", err instanceof Error ? err.name : "unknown_error");
      finish();
    });
  });
}

/** Reads a refused upgrade, releases its request, and returns its wake signal, if any. */
export async function readUpgradeRefusalWake(req: unknown, res: unknown): Promise<RuntimeWakeSignal | null> {
  const refusal = await readUpgradeRefusal(res);
  destroyUpgradeRequest(req);
  return refusal ? classifyRuntimeWakeText(refusal.status, refusal.retryAfter, refusal.body) : null;
}
