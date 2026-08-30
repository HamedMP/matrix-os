import { getGatewayUrl } from "./gateway";
import { isCanonicalShellSessionId } from "../components/terminal/terminal-session-id";

const QUEUE_KEY = "matrix:provider-terminal-session-queue";
const QUEUE_LIMIT = 8;
const QUEUE_TTL_MS = 10 * 60_000;
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const TARGET_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
export const PROVIDER_TERMINAL_SESSION_EVENT = "matrix:provider-terminal-session";

interface QueuedSession {
  sessionId: string;
  targetId?: string;
  expiresAt: number;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function readQueue(): QueuedSession[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.sessionStorage.getItem(QUEUE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    const now = Date.now();
    const queue = value.flatMap((entry): QueuedSession[] => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as { sessionId?: unknown; targetId?: unknown; expiresAt?: unknown };
      if (typeof item.sessionId !== "string" || !isCanonicalShellSessionId(item.sessionId)) return [];
      if (item.targetId !== undefined
        && (typeof item.targetId !== "string" || !TARGET_ID_PATTERN.test(item.targetId))) return [];
      if (!Number.isSafeInteger(item.expiresAt) || (item.expiresAt as number) <= now
        || (item.expiresAt as number) > now + QUEUE_TTL_MS) return [];
      return [{
        sessionId: item.sessionId,
        ...(item.targetId ? { targetId: item.targetId } : {}),
        expiresAt: item.expiresAt as number,
      }];
    }).slice(-QUEUE_LIMIT);
    if (queue.length !== value.length) {
      window.sessionStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    }
    return queue;
  } catch (error) {
    console.warn("[provider-settings] Could not read terminal handoff queue:", error instanceof Error ? error.name : typeof error);
    return [];
  }
}

function writeQueue(queue: QueuedSession[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-QUEUE_LIMIT)));
  } catch (error) {
    console.warn("[provider-settings] Could not persist terminal handoff queue:", error instanceof Error ? error.name : typeof error);
  }
}

export function enqueueExistingTerminalSession(sessionId: string, targetId?: string): boolean {
  if (typeof window === "undefined") return false;
  if (!isCanonicalShellSessionId(sessionId)) return false;
  if (targetId !== undefined && !TARGET_ID_PATTERN.test(targetId)) return false;
  writeQueue([...readQueue(), {
    sessionId,
    ...(targetId ? { targetId } : {}),
    expiresAt: Date.now() + QUEUE_TTL_MS,
  }]);
  window.dispatchEvent(new CustomEvent(PROVIDER_TERMINAL_SESSION_EVENT, { detail: { targetId } }));
  return true;
}

async function listActiveSessions(fetcher: Fetcher): Promise<Set<string>> {
  const response = await fetcher(`${getGatewayUrl()}/api/terminal/sessions`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const declaredLength = Number(response.headers.get("content-length"));
  if (!response.ok || (Number.isFinite(declaredLength) && declaredLength > RESPONSE_LIMIT_BYTES)) return new Set();
  if (!response.body) return new Set();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      return new Set();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    console.warn("[provider-settings] Invalid terminal session response:", error instanceof Error ? error.name : typeof error);
    return new Set();
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as { sessions?: unknown }).sessions)) return new Set();
  const sessions = (value as { sessions: unknown[] }).sessions;
  if (sessions.length > 256) return new Set();
  const active = new Set<string>();
  for (const entry of sessions) {
    if (!entry || typeof entry !== "object") return new Set();
    const session = entry as { name?: unknown; status?: unknown };
    if (typeof session.name !== "string" || !isCanonicalShellSessionId(session.name)
      || (session.status !== "active" && session.status !== "exited")) return new Set();
    if (session.status === "active") active.add(session.name);
  }
  return active;
}

export async function drainExistingTerminalSessionQueue(
  targetId?: string,
  options: { fetcher?: Fetcher } = {},
): Promise<string[]> {
  const queued = readQueue();
  const matchesTarget = (entry: QueuedSession) => !targetId || entry.targetId === targetId || !entry.targetId;
  const matched = queued.filter(matchesTarget);
  if (matched.length === 0) return [];
  try {
    const active = await listActiveSessions(options.fetcher ?? fetch);
    const accepted = new Set(matched.map((entry) => entry.sessionId).filter((id) => active.has(id)));
    writeQueue(queued.filter((entry) => !(matchesTarget(entry) && accepted.has(entry.sessionId))));
    return [...accepted];
  } catch (error) {
    console.warn("[provider-settings] Terminal session handoff failed:", error instanceof Error ? error.name : typeof error);
    return [];
  }
}

export function hasQueuedExistingTerminalSession(targetId?: string): boolean {
  return readQueue().some((entry) => !targetId || entry.targetId === targetId || !entry.targetId);
}

export async function drainExistingTerminalSessionQueueWithRetry(
  targetId?: string,
  options: {
    fetcher?: Fetcher;
    wait?: (delayMs: number) => Promise<void>;
    maxAttempts?: number;
  } = {},
): Promise<string[]> {
  const maxAttempts = Number.isSafeInteger(options.maxAttempts)
    ? Math.max(1, Math.min(options.maxAttempts!, 8))
    : 6;
  const wait = options.wait ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  }));
  const accepted = new Set<string>();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    for (const sessionId of await drainExistingTerminalSessionQueue(targetId, {
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    })) {
      accepted.add(sessionId);
    }
    if (!hasQueuedExistingTerminalSession(targetId) || attempt === maxAttempts - 1) break;
    await wait(Math.min(250 * (2 ** attempt), 2_000));
  }
  return [...accepted];
}
