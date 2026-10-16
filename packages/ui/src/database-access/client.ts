import { z } from "zod/v4";

export const DATABASE_ERROR = "Database access unavailable";
export const DATABASE_EXPORT_MAX_BYTES = 512 * 1024 * 1024;
export const DATABASE_ACTION_HEADERS = { "Content-Type": "application/json", "X-Matrix-Database-Action": "1" };
const identifier = z.string().min(1).max(63).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
const connection = z.strictObject({ host: z.literal("127.0.0.1"), port: z.number().int().min(1).max(65535), database: identifier, username: identifier });
const snapshot = z.strictObject({ connection, credentialReady: z.boolean() });
const credential = z.strictObject({ username: identifier, password: z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/) });
export type DatabaseSnapshot = z.infer<typeof snapshot>;
export type DatabaseCredential = z.infer<typeof credential>;
export interface DatabaseTransport {
  json(path: string, body: object | undefined, signal: AbortSignal): Promise<unknown>;
  export(signal: AbortSignal): Promise<Blob>;
}
export interface DatabaseClient {
  get(signal: AbortSignal): Promise<DatabaseSnapshot>;
  reveal(signal: AbortSignal): Promise<DatabaseCredential>;
  reset(signal: AbortSignal): Promise<DatabaseCredential>;
  terminal(signal: AbortSignal): Promise<string>;
  export(signal: AbortSignal): Promise<Blob>;
}
function unavailable(): Error { return new Error(DATABASE_ERROR); }
function safeClientError(error: unknown): Error {
  return error instanceof Error && error.message === DATABASE_ERROR ? error : unavailable();
}
// Accept only the server's password-prompting SQL command, never a shell expression.
export function isDatabaseTerminalCommand(value: unknown): value is string {
  return typeof value === "string" && /^psql -h 127\.0\.0\.1 -p [0-9]{1,5} -U [a-zA-Z_][a-zA-Z0-9_]{0,62} -d [a-zA-Z_][a-zA-Z0-9_]{0,62} -W$/.test(value);
}
export function createDatabaseClient(transport: DatabaseTransport): DatabaseClient {
  const json = async <T>(path: string, body: object | undefined, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> => {
    try { const parsed = schema.safeParse(await transport.json(path, body, signal)); if (!parsed.success || signal.aborted) throw unavailable(); return parsed.data; }
    catch (error: unknown) { throw safeClientError(error); }
  };
  return {
    get: signal => json("/api/database", undefined, snapshot, signal),
    reveal: signal => json("/api/database/credentials/reveal", {}, credential, signal),
    reset: signal => json("/api/database/credentials/reset", { confirm: "reset" }, credential, signal),
    async terminal(signal) {
      const result = await json("/api/database/terminal", {}, z.strictObject({command:z.string().max(512)}), signal);
      if (!isDatabaseTerminalCommand(result.command)) throw unavailable(); return result.command;
    },
    async export(signal) {
      try { const blob = await transport.export(signal); if (signal.aborted || blob.size === 0 || blob.size > DATABASE_EXPORT_MAX_BYTES) throw unavailable(); return blob; }
      catch (error: unknown) { throw safeClientError(error); }
    },
  };
}
export async function readDatabaseBytes(response: Response, cap: number): Promise<Uint8Array[]> {
  const reader = response.body?.getReader();
  if (!reader || Number(response.headers.get("content-length")) > cap) { await response.body?.cancel(); throw unavailable(); }
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > cap) { await reader.cancel(); throw unavailable(); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  return chunks;
}
export function createDatabaseFetchTransport(baseUrl: string, fetcher: typeof fetch = fetch, exportCap = DATABASE_EXPORT_MAX_BYTES): DatabaseTransport {
  async function request(path: string, body: object | undefined, signal: AbortSignal, timeoutMs: number) {
    const response = await fetcher(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin",
      headers: body === undefined ? { Accept: "application/json" } : DATABASE_ACTION_HEADERS,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) { await response.body?.cancel(); throw unavailable(); } return response;
  }
  return {
    async json(path, body, signal) {
      const chunks = await readDatabaseBytes(await request(path, body, signal, 15_000), 16 * 1024);
      return JSON.parse(await new Blob(chunks as BlobPart[]).text());
    },
    async export(signal) { return new Blob(await readDatabaseBytes(await request("/api/database/export", { confirm: "export" }, signal, 300_000), exportCap) as BlobPart[], { type: "application/octet-stream" }); },
  };
}
export async function downloadDatabaseExport(blob: Blob, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw unavailable();
  const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
  anchor.href = url; anchor.download = "matrix-database.dump"; anchor.rel = "noopener";
  document.body.append(anchor);
  try { if (signal.aborted) throw unavailable(); anchor.click(); }
  finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

/** Create the same bounded SQL session for every presentation; adapters supply navigation. */
export async function openDatabaseTerminal(
  transport: Pick<DatabaseTransport, "json">,
  command: string,
  signal: AbortSignal,
  onOpenSession: (sessionId: string) => void,
  isIdentityCurrent: () => boolean = () => true,
): Promise<void> {
  const current = () => !signal.aborted && isIdentityCurrent();
  if (!current() || !isDatabaseTerminalCommand(command)) throw unavailable();
  const ensured = await transport.json("/api/terminal/workspaces/ensure", {}, signal);
  const workspace = z.object({workspace:z.object({id:z.string().regex(/^tws_[0-9a-f]{32}$/)})}).safeParse(ensured);
  if (!current() || !workspace.success) throw unavailable();
  const created = await transport.json(`/api/terminal/workspaces/${workspace.data.workspace.id}/tabs`, {
    name:"SQL Terminal", cwd:"projects", command:["sh","-lc",command],
  }, signal);
  const tab = z.object({tab:z.object({id:z.string().regex(/^tt_[0-9a-f]{32}$/)})}).safeParse(created);
  if (!current() || !tab.success) throw unavailable();
  onOpenSession(`${workspace.data.workspace.id}:${tab.data.tab.id}`);
}
