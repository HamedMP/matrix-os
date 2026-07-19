import { lstat, open, mkdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentKindSchema, AgentSessionStateStore, type AgentKind } from "./agent-session-state.js";
import { normalizeAgentBridgeEvents } from "./agent-session-bridges.js";

const MAX_BRIDGE_STDIN_BYTES = 65_536;
const BRIDGE_LOCK_RETRIES = 50;
const BRIDGE_LOCK_RETRY_MS = 10;
const BRIDGE_LOCK_STALE_MS = 30_000;

export interface IngestAgentBridgePayloadOptions {
  agent: AgentKind;
  eventName: string;
  sessionName: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  store: AgentSessionStateStore;
}

export async function ingestAgentBridgePayload(options: IngestAgentBridgePayloadOptions): Promise<void> {
  const { store, ...bridgeInput } = options;
  const events = normalizeAgentBridgeEvents(bridgeInput);
  for (const event of events) {
    await store.apply(event);
  }
}

export async function withBridgeFileLock<T>(homePath: string, fn: () => Promise<T>): Promise<T> {
  const directory = join(homePath, "system", "agent-sessions");
  const lockPath = join(directory, ".bridge.lock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let attempt = 0;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        return await fn();
      } finally {
        await handle.close();
        await unlink(lockPath).catch((err: unknown) => {
          if (!isMissingFileError(err)) console.warn("[matrix-agent-bridge] lock cleanup failed");
        });
      }
    } catch (err: unknown) {
      if (!isAlreadyExistsError(err)) throw err;
      if (attempt === BRIDGE_LOCK_RETRIES - 1) {
        throw new Error("Agent bridge lock unavailable", { cause: err });
      }
      if (await removeStaleBridgeLock(lockPath)) continue;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, BRIDGE_LOCK_RETRY_MS));
      attempt += 1;
    }
  }
}

async function removeStaleBridgeLock(lockPath: string): Promise<boolean> {
  try {
    const metadata = await lstat(lockPath);
    if (!metadata.isFile() || Date.now() - metadata.mtimeMs <= BRIDGE_LOCK_STALE_MS) return false;
    await unlink(lockPath);
    return true;
  } catch (err: unknown) {
    if (isMissingFileError(err)) return true;
    throw err;
  }
}

async function readBoundedStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of process.stdin) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    total += chunk.byteLength;
    if (total > MAX_BRIDGE_STDIN_BYTES) throw new Error("Agent bridge payload too large");
    chunks.push(chunk);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid agent bridge payload");
  }
  return parsed as Record<string, unknown>;
}

async function main(): Promise<void> {
  try {
    const agent = AgentKindSchema.parse(process.argv[2]);
    const eventName = process.argv[3];
    const sessionName = process.env.ZELLIJ_SESSION_NAME;
    if (!eventName || !sessionName) return;
    const homePath = resolve(process.env.MATRIX_HOME ?? process.env.HOME ?? "");
    if (!homePath) return;
    const payload = await readBoundedStdin();
    const store = new AgentSessionStateStore({ homePath });
    await withBridgeFileLock(homePath, () => ingestAgentBridgePayload({
      agent,
      eventName,
      sessionName,
      occurredAt: new Date().toISOString(),
      payload,
      store,
    }));
  } catch (err: unknown) {
    void err;
    console.warn("[matrix-agent-bridge] event ignored");
  }
}

function isAlreadyExistsError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST";
}

function isMissingFileError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
