import { getGatewayUrl } from "./gateway";
import { isCanonicalShellSessionId } from "../components/terminal/terminal-session-id";

const QUEUE_KEY = "matrix:provider-terminal-session-queue";
const QUEUE_LIMIT = 8;
const QUEUE_TTL_MS = 10 * 60_000;
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const TARGET_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const WORKSPACE_ID_PATTERN = /^tws_[0-9a-f]{32}$/;
const TAB_ID_PATTERN = /^tt_[0-9a-f]{32}$/;
const ACTIVE_TAB_STATUSES = new Set(["starting", "running", "idle"]);
export const PROVIDER_TERMINAL_SESSION_EVENT = "matrix:provider-terminal-session";

interface QueuedSession {
  sessionId?: string;
  terminalRef?: string;
  targetId?: string;
  expiresAt: number;
}

interface ActiveSessionIndex {
  byName: Map<string, string | null>;
  terminalRefs: Set<string>;
  authoritative: boolean;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let volatileQueue: QueuedSession[] | null = null;

function isHandoffSessionName(value: string): boolean {
  return SESSION_NAME_PATTERN.test(value) && !value.startsWith("term_observe_");
}

function readQueue(): QueuedSession[] {
  if (typeof window === "undefined") return [];
  try {
    const fromVolatileQueue = volatileQueue !== null;
    const value = fromVolatileQueue
      ? volatileQueue
      : JSON.parse(window.sessionStorage.getItem(QUEUE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    const now = Date.now();
    let migratedLegacyEntry = false;
    const queue = value.flatMap((entry): QueuedSession[] => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as {
        sessionId?: unknown;
        terminalRef?: unknown;
        targetId?: unknown;
        expiresAt?: unknown;
      };
      const hasSessionId = typeof item.sessionId === "string";
      const hasTerminalRef = typeof item.terminalRef === "string";
      if (hasSessionId === hasTerminalRef) return [];
      if (hasSessionId && !isHandoffSessionName(item.sessionId as string)) return [];
      if (hasTerminalRef && !isCanonicalShellSessionId(item.terminalRef as string)) return [];
      if (item.targetId !== undefined
        && (typeof item.targetId !== "string" || !TARGET_ID_PATTERN.test(item.targetId))) return [];
      const expiresAt = item.expiresAt === undefined ? now + QUEUE_TTL_MS : item.expiresAt;
      if (!Number.isSafeInteger(expiresAt) || (!hasTerminalRef && (expiresAt as number) <= now)
        || (expiresAt as number) > now + QUEUE_TTL_MS) return [];
      migratedLegacyEntry ||= item.expiresAt === undefined;
      return [{
        ...(hasSessionId ? { sessionId: item.sessionId as string } : {}),
        ...(hasTerminalRef ? { terminalRef: item.terminalRef as string } : {}),
        ...(item.targetId ? { targetId: item.targetId } : {}),
        expiresAt: expiresAt as number,
      }];
    }).slice(-QUEUE_LIMIT);
    if (fromVolatileQueue || queue.length !== value.length || migratedLegacyEntry) {
      writeQueue(queue);
    }
    return queue;
  } catch (error) {
    console.warn("[provider-settings] Could not read terminal handoff queue:", error instanceof Error ? error.name : typeof error);
    return [];
  }
}

function writeQueue(queue: QueuedSession[]): boolean {
  if (typeof window === "undefined") return false;
  const boundedQueue = queue.slice(-QUEUE_LIMIT);
  try {
    window.sessionStorage.setItem(QUEUE_KEY, JSON.stringify(boundedQueue));
    volatileQueue = null;
    return true;
  } catch (error) {
    console.warn("[provider-settings] Could not persist terminal handoff queue:", error instanceof Error ? error.name : typeof error);
    // Keep the same bounded, TTL-validated queue available to other terminal
    // mounts for the lifetime of this shell page when Web Storage is blocked.
    volatileQueue = boundedQueue;
    return true;
  }
}

export function enqueueExistingTerminalSession(sessionId: string, targetId?: string): boolean {
  if (typeof window === "undefined") return false;
  if (!isHandoffSessionName(sessionId)) return false;
  if (targetId !== undefined && !TARGET_ID_PATTERN.test(targetId)) return false;
  const queued = writeQueue([...readQueue(), {
    sessionId,
    ...(targetId ? { targetId } : {}),
    expiresAt: Date.now() + QUEUE_TTL_MS,
  }]);
  if (!queued) return false;
  window.dispatchEvent(new CustomEvent(PROVIDER_TERMINAL_SESSION_EVENT, { detail: { targetId } }));
  return true;
}

export function enqueueExistingTerminalRef(terminalRef: string, targetId?: string): boolean {
  if (typeof window === "undefined") return false;
  if (!isCanonicalShellSessionId(terminalRef)) return false;
  if (targetId !== undefined && !TARGET_ID_PATTERN.test(targetId)) return false;
  const queued = writeQueue([...readQueue(), {
    terminalRef,
    ...(targetId ? { targetId } : {}),
    expiresAt: Date.now() + QUEUE_TTL_MS,
  }]);
  if (!queued) return false;
  window.dispatchEvent(new CustomEvent(PROVIDER_TERMINAL_SESSION_EVENT, { detail: { targetId } }));
  return true;
}

function emptyActiveSessionIndex(): ActiveSessionIndex {
  return { byName: new Map(), terminalRefs: new Set(), authoritative: false };
}

async function listActiveSessions(fetcher: Fetcher): Promise<ActiveSessionIndex> {
  const response = await fetcher(`${getGatewayUrl()}/api/terminal/workspaces`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const declaredLength = Number(response.headers.get("content-length"));
  if (!response.ok || (Number.isFinite(declaredLength) && declaredLength > RESPONSE_LIMIT_BYTES)) return emptyActiveSessionIndex();
  if (!response.body) return emptyActiveSessionIndex();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      return emptyActiveSessionIndex();
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
    return emptyActiveSessionIndex();
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as { workspaces?: unknown }).workspaces)) return emptyActiveSessionIndex();
  const workspaces = (value as { workspaces: unknown[] }).workspaces;
  if (workspaces.length > 256) return emptyActiveSessionIndex();
  const active = emptyActiveSessionIndex();
  let tabCount = 0;
  for (const entry of workspaces) {
    if (!entry || typeof entry !== "object") return emptyActiveSessionIndex();
    const workspace = entry as { id?: unknown; tabs?: unknown };
    if (typeof workspace.id !== "string" || !WORKSPACE_ID_PATTERN.test(workspace.id)
      || !Array.isArray(workspace.tabs)) return emptyActiveSessionIndex();
    tabCount += workspace.tabs.length;
    if (tabCount > 256) return emptyActiveSessionIndex();
    for (const tabEntry of workspace.tabs) {
      if (!tabEntry || typeof tabEntry !== "object") return emptyActiveSessionIndex();
      const tab = tabEntry as { id?: unknown; name?: unknown; status?: unknown };
      if (typeof tab.id !== "string" || !TAB_ID_PATTERN.test(tab.id)
        || typeof tab.name !== "string" || tab.name.length < 1 || tab.name.length > 120
        || typeof tab.status !== "string") return emptyActiveSessionIndex();
      if (!ACTIVE_TAB_STATUSES.has(tab.status)) continue;
      const ref = `${workspace.id}:${tab.id}`;
      if (!isCanonicalShellSessionId(ref)) return emptyActiveSessionIndex();
      active.terminalRefs.add(ref);
      if (isHandoffSessionName(tab.name)) {
        active.byName.set(tab.name, active.byName.has(tab.name) ? null : ref);
      }
    }
  }
  active.authoritative = true;
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
    const settledEntries = new Set<QueuedSession>();
    const acceptedRefs = new Set<string>();
    for (const entry of matched) {
      const ref = entry.terminalRef
        ? active.terminalRefs.has(entry.terminalRef) ? entry.terminalRef : undefined
        : active.byName.get(entry.sessionId ?? "") ?? undefined;
      if (entry.terminalRef && active.authoritative) settledEntries.add(entry);
      if (!ref) continue;
      settledEntries.add(entry);
      acceptedRefs.add(ref);
    }
    if (!writeQueue(queued.filter((entry) => !settledEntries.has(entry)))) return [];
    return [...acceptedRefs];
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
