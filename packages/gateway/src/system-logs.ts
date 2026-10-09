/** Owner-facing, redacted journald reads for the core Matrix services on this computer. */
import { execFile } from "node:child_process";
import { z } from "zod/v4";
import { redactDiagnosticSecrets } from "./coding-agents/diagnostics.js";

// Only units that run as the gateway's own user are exposed. Root units, bridges,
// the homeserver, Postgres, and bootstrap output can carry secrets or message metadata.
export const SYSTEM_LOG_UNITS = {
  gateway: "matrix-gateway.service",
  shell: "matrix-shell.service",
  sync: "matrix-sync-agent.service",
  code: "matrix-code.service",
} as const;

export type SystemLogService = keyof typeof SYSTEM_LOG_UNITS;

export const DEFAULT_SYSTEM_LOG_LINES = 200;
export const MAX_SYSTEM_LOG_LINES = 1000;
export const MAX_SYSTEM_LOG_SINCE_SECONDS = 7 * 86_400;
export const MAX_SYSTEM_LOG_LINE_CHARS = 2000;
const JOURNALCTL_TIMEOUT_MS = 5_000;
const JOURNALCTL_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_READS = 2;
const SINCE_UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86_400 } as const;

export interface SystemLogsQuery {
  service: SystemLogService;
  lines: number;
  sinceSeconds?: number;
}

export interface SystemLogsResult {
  service: SystemLogService;
  lines: string[];
  truncated: boolean;
}

export type SystemLogRunner = (args: string[]) => Promise<string>;

export class SystemLogsUnavailableError extends Error {
  constructor(readonly reason: "busy" | "failed") {
    super("System logs are unavailable");
    this.name = "SystemLogsUnavailableError";
  }
}

const SystemLogsQuerySchema = z.object({
  service: z.enum(Object.keys(SYSTEM_LOG_UNITS) as [SystemLogService, ...SystemLogService[]]).default("gateway"),
  lines: z.string().regex(/^\d{1,4}$/).transform(Number)
    .pipe(z.number().int().min(1).max(MAX_SYSTEM_LOG_LINES)).optional(),
  since: z.string().regex(/^\d{1,6}[smhd]$/).transform((value) =>
    Number(value.slice(0, -1)) * SINCE_UNIT_SECONDS[value.at(-1) as keyof typeof SINCE_UNIT_SECONDS])
    .pipe(z.number().int().min(1).max(MAX_SYSTEM_LOG_SINCE_SECONDS)).optional(),
}).strict();

export function parseSystemLogsQuery(input: Record<string, string | undefined>):
  { ok: true; query: SystemLogsQuery } | { ok: false } {
  const parsed = SystemLogsQuerySchema.safeParse(input);
  if (!parsed.success) return { ok: false };
  return {
    ok: true,
    query: {
      service: parsed.data.service,
      lines: parsed.data.lines ?? DEFAULT_SYSTEM_LOG_LINES,
      ...(parsed.data.since === undefined ? {} : { sinceSeconds: parsed.data.since }),
    },
  };
}

export const runJournalctl: SystemLogRunner = (args) => new Promise((resolve, reject) => {
  execFile("journalctl", args, {
    encoding: "utf8",
    timeout: JOURNALCTL_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: JOURNALCTL_MAX_BUFFER_BYTES,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", SYSTEMD_COLORS: "0" },
  }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

function redactLine(line: string): { line: string; truncated: boolean } {
  // Bound regex work on pathological lines, then cap what the owner sees.
  const redacted = redactDiagnosticSecrets(line.slice(0, MAX_SYSTEM_LOG_LINE_CHARS * 4));
  if (line.length <= MAX_SYSTEM_LOG_LINE_CHARS && redacted.length <= MAX_SYSTEM_LOG_LINE_CHARS) {
    return { line: redacted, truncated: false };
  }
  return { line: `${redacted.slice(0, MAX_SYSTEM_LOG_LINE_CHARS - 3)}...`, truncated: true };
}

export interface SystemLogReader {
  read(query: SystemLogsQuery): Promise<SystemLogsResult>;
}

export function createSystemLogReader(options: {
  run?: SystemLogRunner;
  now?: () => number;
  maxConcurrent?: number;
} = {}): SystemLogReader {
  const run = options.run ?? runJournalctl;
  const now = options.now ?? Date.now;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_READS;
  let active = 0;

  return {
    async read(query) {
      if (active >= maxConcurrent) throw new SystemLogsUnavailableError("busy");
      const args = [
        "--unit", SYSTEM_LOG_UNITS[query.service],
        "--no-pager", "--quiet",
        "--output", "short-iso",
        "--lines", String(query.lines),
        ...(query.sinceSeconds === undefined
          ? []
          : ["--since", `@${Math.floor(now() / 1000) - query.sinceSeconds}`]),
      ];
      active += 1;
      let stdout: string;
      try {
        stdout = await run(args);
      } catch (error: unknown) {
        console.warn("[system-logs] journal read failed", error instanceof Error ? error.name : "UnknownError");
        throw new SystemLogsUnavailableError("failed");
      } finally {
        active -= 1;
      }
      let truncated = false;
      const lines = stdout.split("\n").filter((line) => line.length > 0).slice(-query.lines).map((raw) => {
        const result = redactLine(raw);
        truncated ||= result.truncated;
        return result.line;
      });
      return { service: query.service, lines, truncated };
    },
  };
}
