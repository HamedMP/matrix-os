// What a Matrix computer may ask of this device's private herdr-core over the
// Desktop link (spec 2716): Herdr terminals as the signed-in macOS user, and
// nothing else. One guard per core stream. Everything the computer sends
// passes through here before the core sees it; refused calls are answered
// here and never reach the core.
import { realpath, stat } from "node:fs/promises";
import { sep } from "node:path";
import { DESKTOP_LINK_METHODS } from "@matrix-os/contracts/desktop-link";
import { encodeFrame, HC_FRAME, HcFrameDecoder } from "@matrix-os/herdr-core-client/protocol";

const ALLOWED: ReadonlySet<string> = new Set(DESKTOP_LINK_METHODS);
const MAX_HELLO_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_ARGV = 64;
const MAX_ARG_CHARS = 4 * 1024;
const MAX_LINE_CHARS = 16 * 1024;
const MAX_LABELS = 32;
const MAX_LABEL_CHARS = 256;
/** Pasted files: herdr-core takes up to 8 MB raw per put. */
const MAX_PUT_BASE64_CHARS = Math.ceil((16 * 1024 * 1024 * 4) / 3);
export const DESKTOP_LINK_FROM_LABEL = "matrix.from";
const ENV_ALLOWED = /^(TERM|COLORTERM|LANG|LC_[A-Z_]+)$/;
// Parameters that name a terminal. None may point at another machine (`mac/t3`).
const TERMINAL_FIELDS = ["terminal", "parent", "caller", "children_of"] as const;
const HELLO_FIELDS: ReadonlySet<string> = new Set(["framed", "generation", "features"]);

/** The stream must end: the computer broke the protocol. */
export class DesktopLinkGuardError extends Error {
  constructor(readonly reason: "handshake" | "malformed" | "too_large") {
    super("desktop link stream refused");
    this.name = "DesktopLinkGuardError";
  }
}

export interface DesktopLinkGuardResult {
  /** Bytes for the core, in order. */
  toCore: Buffer[];
  /** Answers for the computer to refused calls. */
  toComputer: Buffer[];
}

export interface DesktopLinkGuardOptions {
  /** The macOS user's home; terminals start here or in a folder under it. */
  home: string;
  /** The computer's name, written on every terminal it starts. */
  computerName: string;
  /** Replaced in tests. Resolves symlinks; rejects when the folder does not exist. */
  resolveFolder?: (path: string) => Promise<string>;
}

type Request = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type Verdict = { forward: Record<string, unknown> } | { deny: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function denial(id: unknown): Buffer {
  const reply = { jsonrpc: "2.0", id: typeof id === "number" || typeof id === "string" ? id : null,
    error: { code: -32601, message: "not allowed from this computer", data: { kind: "denied" } } };
  return encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify(reply)));
}

function stringsWithin(value: unknown, max: number, each: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string" && item.length <= each);
}

function labelsWithin(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_LABELS
    && entries.every(([key, label]) => key.length <= MAX_LABEL_CHARS && typeof label === "string" && label.length <= MAX_LABEL_CHARS);
}

export function createDesktopLinkGuard(options: DesktopLinkGuardOptions) {
  const resolveFolder = options.resolveFolder ?? (async (path: string) => {
    const resolved = await realpath(path);
    if (!(await stat(resolved)).isDirectory()) throw new Error("not a folder");
    return resolved;
  });
  const decoder = new HcFrameDecoder();
  let greeted = false;
  let pending: Buffer = Buffer.alloc(0);
  let home: Promise<string> | null = null;

  /** A folder the computer names, or home when it names none: always inside home, after symlinks. */
  async function folderUnderHome(cwd: unknown): Promise<string | null> {
    home ??= resolveFolder(options.home);
    const root = await home;
    if (cwd === undefined || cwd === null) return root;
    if (typeof cwd !== "string" || cwd.length > MAX_ARG_CHARS || cwd.includes("\0")) return null;
    let resolved: string;
    try {
      resolved = await resolveFolder(cwd.startsWith("/") ? cwd : `${root}${sep}${cwd}`);
    } catch (error: unknown) {
      if (error instanceof Error) return null;
      throw error;
    }
    return resolved === root || resolved.startsWith(root + sep) ? resolved : null;
  }

  async function judge(method: string, params: Record<string, unknown>): Promise<Verdict> {
    if (!ALLOWED.has(method) || method === "hello") return { deny: true };
    // Nothing is routed onward to a machine this device's core can reach.
    if ("on" in params && params.on !== null) return { deny: true };
    for (const field of TERMINAL_FIELDS) {
      const value = params[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || value.length > 128 || value.includes("/")) return { deny: true };
    }
    if (method === "terminal.run") {
      const { argv, line, env, labels } = params;
      if (argv !== undefined && !stringsWithin(argv, MAX_ARGV, MAX_ARG_CHARS)) return { deny: true };
      if (line !== undefined && line !== null && (typeof line !== "string" || line.length > MAX_LINE_CHARS)) return { deny: true };
      if (env !== undefined && (!isRecord(env) || Object.entries(env).some(([key, value]) => !ENV_ALLOWED.test(key) || typeof value !== "string" || value.length > MAX_LABEL_CHARS))) {
        return { deny: true };
      }
      if (labels !== undefined && !labelsWithin(labels)) return { deny: true };
      const cwd = await folderUnderHome(params.cwd);
      if (cwd === null) return { deny: true };
      return { forward: {
        ...params,
        cwd,
        labels: { ...(labels as Record<string, string> | undefined), [DESKTOP_LINK_FROM_LABEL]: options.computerName },
      } };
    }
    if (method === "terminal.label") {
      if (!labelsWithin(params.labels) || DESKTOP_LINK_FROM_LABEL in params.labels) return { deny: true };
    }
    if (method === "terminal.put" && (typeof params.data !== "string" || params.data.length > MAX_PUT_BASE64_CHARS)) {
      return { deny: true };
    }
    return { forward: params };
  }

  /** The first, unframed line: `hello`, framed, and asking to be nothing more than a client. */
  function greet(line: Buffer): Buffer {
    let request: Request;
    try { request = JSON.parse(line.toString("utf8")) as Request; } catch (error: unknown) {
      if (error instanceof SyntaxError) throw new DesktopLinkGuardError("handshake");
      throw error;
    }
    const params = request?.params;
    if (!isRecord(request) || request.method !== "hello" || !isRecord(params) || params.framed !== true
      || Object.keys(params).some((key) => !HELLO_FIELDS.has(key))) {
      throw new DesktopLinkGuardError("handshake");
    }
    return Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, method: "hello", params })}\n`);
  }

  return {
    /**
     * Takes the next bytes from the computer. Call again only after the
     * previous call settled, so order is kept. Throws DesktopLinkGuardError when
     * the stream must end.
     */
    async push(chunk: Buffer): Promise<DesktopLinkGuardResult> {
      const result: DesktopLinkGuardResult = { toCore: [], toComputer: [] };
      let bytes = chunk;
      if (!greeted) {
        pending = Buffer.concat([pending, bytes]);
        const newline = pending.indexOf(10);
        if (newline < 0) {
          if (pending.length > MAX_HELLO_BYTES) throw new DesktopLinkGuardError("too_large");
          return result;
        }
        if (newline > MAX_HELLO_BYTES) throw new DesktopLinkGuardError("too_large");
        result.toCore.push(greet(pending.subarray(0, newline)));
        greeted = true;
        bytes = pending.subarray(newline + 1);
        pending = Buffer.alloc(0);
        if (bytes.length === 0) return result;
      }
      let frames;
      try { frames = decoder.push(bytes); } catch (error: unknown) {
        if (error instanceof Error) throw new DesktopLinkGuardError("too_large");
        throw error;
      }
      for (const frame of frames) {
        // Stream bytes, credit, resize and close for channels the core opened pass as they are.
        if (frame.channel !== 0) { result.toCore.push(encodeFrame(frame.channel, frame.kind, frame.payload)); continue; }
        if (frame.kind !== HC_FRAME.DATA) continue;
        if (frame.payload.length > MAX_REQUEST_BYTES) throw new DesktopLinkGuardError("too_large");
        let request: Request;
        try { request = JSON.parse(frame.payload.toString("utf8")) as Request; } catch (error: unknown) {
          if (error instanceof SyntaxError) throw new DesktopLinkGuardError("malformed");
          throw error;
        }
        if (!isRecord(request) || typeof request.method !== "string") {
          // A reply from the computer to a call this core made. This core
          // never calls a client that is not a peer, so there are none.
          continue;
        }
        const params = request.params === undefined ? {} : request.params;
        const verdict = isRecord(params) ? await judge(request.method, params) : { deny: true as const };
        if ("deny" in verdict) {
          // A notification (no id) is dropped; a call gets an answer.
          if (request.id !== undefined) result.toComputer.push(denial(request.id));
          continue;
        }
        result.toCore.push(encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ ...request, params: verdict.forward }))));
      }
      return result;
    },
  };
}

export type DesktopLinkGuard = ReturnType<typeof createDesktopLinkGuard>;
