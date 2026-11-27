/**
 * The one typing of `window.MatrixOS` for default apps.
 *
 * It declares what the injected bridge provides (shell/src/lib/os-bridge.ts)
 * and nothing else. Wire shapes for `files` come from
 * packages/contracts/src/app-files.ts and office-open-with.ts; default apps are
 * isolated pnpm projects and cannot import that package, so the shapes are
 * repeated here and must change together with it.
 *
 * Use it from an app with one file, `src/matrix-os.d.ts`:
 *
 *   /// <reference path="../../_shared/matrix-os.d.ts" />
 *
 * and import named types where needed:
 *
 *   import type { BridgeFileError, OpenRequest } from "../../_shared/matrix-os";
 *
 * Rules that follow from the sandbox (srcdoc iframe, origin null,
 * CSP connect-src 'self'): never call fetch() to a gateway URL and never use
 * localStorage; go through this bridge.
 *
 * Electron Desktop exposes a smaller bridge today: it has no `readData`,
 * `writeData`, `onDataChange`, `navigate`, `proxyFetch`, `theme`, `design` or
 * `app`, and it has `files` only once the parity work in
 * specs/2710-office-mail-suite/bridge-files.md lands. Code that must run there
 * checks for a member before it uses it.
 */

// ---------------------------------------------------------------- files

/** Why a `files` call failed. The message is generic; detail stays on the server. */
export type BridgeFileErrorCode =
  | "not_found"
  | "forbidden"
  | "too_large"
  | "version_conflict"
  | "invalid_request"
  | "unavailable";

/**
 * Every `files` method rejects with this shape. The error object is created
 * by the bridge, so test it by name, not with `instanceof`:
 *
 *   if ((error as BridgeFileError)?.name === "BridgeFileError") { ... error.code ... }
 */
export interface BridgeFileError extends Error {
  name: "BridgeFileError";
  code: BridgeFileErrorCode;
}

/**
 * Opaque token for one state of a file. The gateway computes it from the
 * file's size and modification time. Keep the value from `read`, `stat` or
 * `write` and pass it back as `ifVersion`; never parse or build one.
 */
export type BridgeFileVersion = string;

export interface BridgeFileEntry {
  name: string;
  /** Home-relative path, forward slashes. */
  path: string;
  kind: "file" | "dir";
  /** Bytes; 0 for a directory. */
  size: number;
  /** ISO 8601 UTC time. */
  modifiedAt: string;
}

export interface BridgeFileListing {
  /** Directories first, then by name. At most 500 entries. */
  entries: BridgeFileEntry[];
  /** True when the directory holds more entries than were returned. */
  truncated: boolean;
}

export interface BridgeFileStat {
  path: string;
  size: number;
  modifiedAt: string;
  version: BridgeFileVersion;
}

export interface BridgeFileContent {
  path: string;
  bytes: Uint8Array;
  size: number;
  version: BridgeFileVersion;
  mimeType: string;
}

export interface BridgeFileWriteOptions {
  /**
   * The version this app last read. The write fails with `version_conflict`
   * when the file has changed since. `null` means the file must not exist yet.
   */
  ifVersion: BridgeFileVersion | null;
  /** Create missing parent directories. Without it a missing parent is `not_found`. */
  createParents?: boolean;
}

export interface BridgeFileWriteResult {
  path: string;
  /** The version to send with the next write. */
  version: BridgeFileVersion;
  size: number;
  modifiedAt: string;
}

/** A file that Files asked this app to open. */
export interface OpenRequest {
  /** Home-relative path. */
  path: string;
  /** ISO 8601 UTC time of the request. */
  requestedAt: string;
  /** Unique per request. */
  nonce: string;
}

/**
 * Files in the owner's home. Available only to first-party apps whose
 * matrix.json lists the `files` permission; other apps get `forbidden`.
 *
 * Paths are relative to the home, use forward slashes, are at most 4096
 * characters and contain no NUL, backslash, leading or trailing slash, or
 * `.` / `..` segment. Protected parts of the home (`system`, `agents`, dot
 * directories at the top level) cannot be read or written. A file is at most
 * 10 MiB; larger content fails with `too_large`.
 */
export interface MatrixOSFiles {
  /** Lists a directory. `""` is the home root. `limit` is 1 to 500 (default 500). */
  list(dir: string, options?: { limit?: number }): Promise<BridgeFileListing>;
  /** Describes a regular file without reading it. */
  stat(path: string): Promise<BridgeFileStat>;
  read(path: string): Promise<BridgeFileContent>;
  /** Replaces the whole file atomically, subject to `options.ifVersion`. */
  write(path: string, bytes: Uint8Array, options: BridgeFileWriteOptions): Promise<BridgeFileWriteResult>;
  /** Creates a directory and missing parents. An existing directory is success. */
  mkdir(path: string): Promise<{ path: string }>;
  /**
   * The file this app was launched to open, or null. A request is returned
   * once and then recorded as handled, so a reload does not reopen it; call
   * it one time on load. It resolves null, and never rejects, when nothing is
   * pending or the request is stale.
   */
  openRequest(): Promise<OpenRequest | null>;
  /** Calls back for each request that arrives while the app is running. Returns an unsubscribe function. */
  onOpenRequest(callback: (request: OpenRequest) => void): () => void;
}

// ---------------------------------------------------------------- database

export type MatrixOSDbComparable = string | number | boolean | null;

export interface MatrixOSDbFilterOperators {
  $eq?: MatrixOSDbComparable;
  $ne?: MatrixOSDbComparable;
  $lt?: string | number;
  $lte?: string | number;
  $gt?: string | number;
  $gte?: string | number;
  /** At most 200 values. */
  $in?: MatrixOSDbComparable[];
  $like?: string;
  $ilike?: string;
}

export type MatrixOSDbFilter = Record<string, MatrixOSDbComparable | MatrixOSDbFilterOperators>;
export type MatrixOSDbRow = Record<string, unknown>;

export interface MatrixOSDbFindOptions {
  where?: MatrixOSDbFilter;
  orderBy?: Record<string, "asc" | "desc">;
  limit?: number;
  offset?: number;
}

/** Tables are declared in matrix.json `storage.tables`. A request is at most 1 MB and has 10 s. */
export interface MatrixOSDb {
  find(table: string, options?: MatrixOSDbFindOptions): Promise<MatrixOSDbRow[]>;
  findOne(table: string, id: string): Promise<MatrixOSDbRow | null>;
  insert(table: string, data: MatrixOSDbRow): Promise<{ id: string }>;
  /** At most 200 rows. */
  bulkInsert(table: string, rows: MatrixOSDbRow[]): Promise<{ ids: string[] }>;
  update(table: string, id: string, data: MatrixOSDbRow): Promise<{ ok: true }>;
  /** Updates the row only if its stored payload still equals `expectedPayload`. */
  compareAndSwap(table: string, id: string, expectedPayload: MatrixOSDbRow, data: MatrixOSDbRow): Promise<{ ok: boolean }>;
  /** At most 200 updates. */
  bulkUpdate(table: string, updates: Array<{ id: string; data: MatrixOSDbRow }>): Promise<{ ok: true }>;
  delete(table: string, id: string): Promise<{ ok: true }>;
  count(table: string, filter?: MatrixOSDbFilter): Promise<number>;
  appInfo(): Promise<{ installedVersion: string | null }>;
  /** Calls back after any write to `table` by this app, from any window. */
  onChange(table: string, callback: (event: { table: string }) => void): () => void;
}

// ---------------------------------------------------------------- AI

export interface MatrixOSAiRouteSelection {
  harnessId: string;
  accountId: string | null;
  accessSourceId: string;
  modelId: string;
}

export interface MatrixOSAiRoute extends MatrixOSAiRouteSelection {
  displayName: string;
  availability: "available" | "unavailable";
  readiness: "ready" | "local_profile" | "unavailable";
  reason: "disabled" | "not_ready" | "completion_unavailable" | null;
}

export interface MatrixOSAi {
  routes(): Promise<{ routes: MatrixOSAiRoute[]; defaultRoute: MatrixOSAiRouteSelection | null }>;
  /** `prompt` is 1 to 32000 characters; the reply text is at most 64000. */
  generate(input: { prompt: string; route?: MatrixOSAiRouteSelection }): Promise<{ text: string }>;
}

// ---------------------------------------------------------------- integrations

export interface MatrixOSCapabilities {
  version: 1;
  integrations: boolean;
  ai: boolean;
}

export interface MatrixOSConnectedService {
  service: string;
  account_label: string;
  account_email?: string | null;
  status: string;
}

export interface MatrixOSServiceAction {
  id: string;
  description: string;
  risk: "read" | "write" | "destructive";
  params: Record<string, unknown>;
}

export interface MatrixOSServiceDescription {
  service: string;
  name: string;
  actions: MatrixOSServiceAction[];
}

export interface MatrixOSServiceResult<T = unknown> {
  data: T;
  summary?: string;
  service: string;
  action: string;
}

// ---------------------------------------------------------------- collaboration

export interface MatrixOSCollaborationParticipant {
  readonly actorId: string;
  readonly displayName: string;
  readonly organizationId?: string;
  readonly scopeId?: string;
  readonly shareRevision?: string;
  readonly buildId?: string;
}

export interface MatrixOSCollaboration {
  /** Who is viewing a shared app, or null in the owner's own session. Display data only. */
  participant: MatrixOSCollaborationParticipant | null;
  query(action: unknown): Promise<unknown>;
  /** `expectedRevision` is a decimal string without leading zeros. */
  mutate(action: unknown, expectedRevision: string): Promise<unknown>;
  retryMutation(): Promise<unknown>;
  /** At most 32 listeners. */
  onChange(callback: () => void): () => void;
}

// ---------------------------------------------------------------- bridge

export interface MatrixOSBridge {
  /** Identity of the running app. */
  app: { name: string };
  /** Current theme as CSS custom properties; replaced when the theme changes. */
  theme: Record<string, string>;
  /** Active design id, also set as `data-matrix-design` on the root element. */
  design: string;

  /** Sends `context` to the agent as a task from this app. Returns nothing. */
  generate(context: string): void;
  /** Asks the agent to go to `route`, with optional context. */
  navigate(route: string, context?: string): void;
  /** Opens another app by name and app path. */
  openApp(name: string, path: string): void;

  /** Key-value store private to this app. Keys keep only `[a-zA-Z0-9_-]`. Resolves null for a missing key. */
  readData(key: string): Promise<unknown>;
  /** The value must be JSON-serializable; one write is at most 1 MB. */
  writeData(key: string, value: unknown): Promise<void>;
  /** Calls back after a key-value write (`key`) or a table write (`key` is the table name). */
  onDataChange(callback: (key: string, app: string) => void): () => void;

  db: MatrixOSDb;
  files: MatrixOSFiles;
  ai: MatrixOSAi;
  collaboration: MatrixOSCollaboration;

  capabilities(): Promise<MatrixOSCapabilities>;
  /** Connected accounts this app may use. */
  integrations(): Promise<MatrixOSConnectedService[]>;
  describeService(service: string): Promise<MatrixOSServiceDescription>;
  /** Runs one integration action on the single connected account of `service`, or the one named by `label`. */
  service<T = unknown>(service: string, action: string, params?: Record<string, unknown>, label?: string): Promise<MatrixOSServiceResult<T>>;

  /** JSON request to an allowlisted `/api/bridge/*` gateway path. Prefer the typed members above. */
  gatewayFetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }, timeoutMs?: number): Promise<unknown>;
  /** GET of an allowlisted external JSON URL, made by the gateway. */
  proxyFetch(url: string): Promise<unknown>;
}

declare global {
  interface Window {
    MatrixOS: MatrixOSBridge;
  }
}
