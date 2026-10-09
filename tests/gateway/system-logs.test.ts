import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_CONTEXT_READY_CONTEXT_KEY,
  JWT_CLAIMS_CONTEXT_KEY,
  VERIFIED_RUNTIME_BEARER_CONTEXT_KEY,
} from "../../packages/gateway/src/request-principal.js";
import {
  MAX_SYSTEM_LOG_LINE_CHARS,
  SystemLogsUnavailableError,
  createSystemLogReader,
  parseSystemLogsQuery,
  type SystemLogRunner,
} from "../../packages/gateway/src/system-logs.js";
import { registerSystemLogRoutes } from "../../packages/gateway/src/server/system-log-routes.js";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");

function runnerReturning(stdout: string): SystemLogRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = vi.fn(async (args: string[]) => {
    calls.push(args);
    return stdout;
  });
  return Object.assign(run, { calls });
}

describe("parseSystemLogsQuery", () => {
  it("defaults to the gateway service with 200 lines and no time window", () => {
    expect(parseSystemLogsQuery({})).toEqual({ ok: true, query: { service: "gateway", lines: 200 } });
  });

  it("accepts every allowlisted service, bounded lines, and bounded since windows", () => {
    for (const service of ["gateway", "shell", "sync", "code"]) {
      expect(parseSystemLogsQuery({ service }).ok).toBe(true);
    }
    expect(parseSystemLogsQuery({ lines: "1000", since: "7d" })).toEqual({
      ok: true,
      query: { service: "gateway", lines: 1000, sinceSeconds: 7 * 86_400 },
    });
    expect(parseSystemLogsQuery({ since: "15m" })).toEqual({
      ok: true,
      query: { service: "gateway", lines: 200, sinceSeconds: 900 },
    });
  });

  it("rejects units outside the allowlist, unbounded line counts, and malformed windows", () => {
    for (const input of [
      { service: "postgres" },
      { service: "matrix-gateway.service" },
      { service: "gateway --all" },
      { lines: "0" },
      { lines: "1001" },
      { lines: "12abc" },
      { lines: "-5" },
      { since: "8d" },
      { since: "0h" },
      { since: "1 hour ago" },
      { since: "@0" },
    ]) {
      expect(parseSystemLogsQuery(input)).toEqual({ ok: false });
    }
  });
});

describe("createSystemLogReader", () => {
  it("runs journalctl for the mapped unit with fixed, bounded arguments", async () => {
    const runner = runnerReturning("2026-10-09T11:59:00+0000 matrix-vm matrix-shell[1]: ready\n");
    const reader = createSystemLogReader({ run: runner, now: () => NOW });

    const result = await reader.read({ service: "shell", lines: 50, sinceSeconds: 3600 });

    expect(runner.calls).toEqual([[
      "--unit", "matrix-shell.service",
      "--no-pager", "--quiet",
      "--output", "short-iso",
      "--lines", "50",
      "--since", `@${Math.floor(NOW / 1000) - 3600}`,
    ]]);
    expect(result).toEqual({
      service: "shell",
      lines: ["2026-10-09T11:59:00+0000 matrix-vm matrix-shell[1]: ready"],
      truncated: false,
    });
  });

  it("omits --since when no window is requested", async () => {
    const runner = runnerReturning("");
    const reader = createSystemLogReader({ run: runner, now: () => NOW });

    const result = await reader.read({ service: "sync", lines: 10 });

    expect(runner.calls[0]).not.toContain("--since");
    expect(runner.calls[0]).toContain("matrix-sync-agent.service");
    expect(result.lines).toEqual([]);
  });

  it("redacts secrets, owner paths, and private hosts from every line", async () => {
    const runner = runnerReturning([
      "gw[1]: request failed Authorization: Bearer abc.def.ghi",
      "gw[1]: ANTHROPIC_API_KEY=sk-ant-supersecretvalue1234 loaded",
      "gw[1]: cannot open /home/matrix/home/system/secret.json",
      "gw[1]: connect ECONNREFUSED 10.0.0.12:5432",
      "gw[1]: upstream https://internal.example/path?token=abc failed",
    ].join("\n"));
    const reader = createSystemLogReader({ run: runner, now: () => NOW });

    const { lines } = await reader.read({ service: "gateway", lines: 200 });
    const joined = lines.join("\n");

    expect(lines).toHaveLength(5);
    expect(joined).not.toContain("abc.def.ghi");
    expect(joined).not.toContain("supersecretvalue");
    expect(joined).not.toContain("/home/matrix");
    expect(joined).not.toContain("10.0.0.12");
    expect(joined).not.toContain("internal.example");
    expect(joined).toContain("[token]");
    expect(joined).toContain("[path]");
  });

  it("caps each line and reports truncation without dropping the line", async () => {
    const long = `gw[1]: ${"x".repeat(MAX_SYSTEM_LOG_LINE_CHARS * 2)}`;
    const reader = createSystemLogReader({ run: runnerReturning(`${long}\nshort`), now: () => NOW });

    const result = await reader.read({ service: "gateway", lines: 200 });

    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].length).toBeLessThanOrEqual(MAX_SYSTEM_LOG_LINE_CHARS);
    expect(result.lines[1]).toBe("short");
    expect(result.truncated).toBe(true);
  });

  it("never returns more lines than requested", async () => {
    const stdout = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const reader = createSystemLogReader({ run: runnerReturning(stdout), now: () => NOW });

    const result = await reader.read({ service: "gateway", lines: 10 });

    expect(result.lines).toEqual(Array.from({ length: 10 }, (_, index) => `line ${index + 20}`));
  });

  it("maps runner failures to a generic unavailable error", async () => {
    const reader = createSystemLogReader({
      run: vi.fn(async () => { throw Object.assign(new Error("spawn journalctl ENOENT"), { code: "ENOENT" }); }),
      now: () => NOW,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(reader.read({ service: "gateway", lines: 10 })).rejects.toBeInstanceOf(SystemLogsUnavailableError);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0])).not.toContain("ENOENT");
  });

  it("refuses to start more concurrent reads than the cap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reader = createSystemLogReader({
      run: vi.fn(async () => { await gate; return "ok"; }),
      now: () => NOW,
      maxConcurrent: 1,
    });

    const first = reader.read({ service: "gateway", lines: 1 });
    await expect(reader.read({ service: "gateway", lines: 1 })).rejects.toMatchObject({ reason: "busy" });
    release();
    await expect(first).resolves.toMatchObject({ lines: ["ok"] });
    await expect(reader.read({ service: "gateway", lines: 1 })).resolves.toMatchObject({ lines: ["ok"] });
  });
});

describe("GET /api/system/logs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function appWith(options: {
    verifiedBearer?: boolean;
    sub?: string;
    authorization?: string | null;
    read?: ReturnType<typeof vi.fn>;
  } = {}) {
    const read = options.read ?? vi.fn(async () => ({ service: "gateway", lines: ["ready"], truncated: false }));
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set(AUTH_CONTEXT_READY_CONTEXT_KEY as never, true as never);
      if (options.verifiedBearer !== false) c.set(VERIFIED_RUNTIME_BEARER_CONTEXT_KEY as never, true as never);
      if (options.sub) c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: options.sub } as never);
      await next();
    });
    registerSystemLogRoutes({ app, reader: { read } });
    const headers: Record<string, string> = {};
    if (options.authorization !== null) headers.authorization = options.authorization ?? "Bearer owner-token";
    return {
      read,
      request: (query = "") => app.request(`/api/system/logs${query}`, { headers }),
    };
  }

  it("returns redacted log lines for the owner's CLI bearer", async () => {
    vi.stubEnv("MATRIX_USER_ID", "user_owner");
    const { request, read } = appWith({ sub: "user_owner" });

    const res = await request("?service=gateway&lines=20&since=1h");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ service: "gateway", lines: ["ready"], truncated: false });
    expect(read).toHaveBeenCalledWith({ service: "gateway", lines: 20, sinceSeconds: 3600 });
  });

  it("rejects requests without verified runtime bearer proof", async () => {
    vi.stubEnv("MATRIX_USER_ID", "user_owner");
    const { request, read } = appWith({ sub: "user_owner", verifiedBearer: false });

    const res = await request();

    expect(res.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects cookie-style requests without a bearer header", async () => {
    vi.stubEnv("MATRIX_USER_ID", "user_owner");
    const { request, read } = appWith({ sub: "user_owner", authorization: null });

    expect((await request()).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a verified principal that is not the configured owner", async () => {
    vi.stubEnv("MATRIX_USER_ID", "user_owner");
    const { request, read } = appWith({ sub: "user_collaborator" });

    expect((await request()).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects invalid queries without echoing them", async () => {
    vi.stubEnv("MATRIX_USER_ID", "user_owner");
    const { request, read } = appWith({ sub: "user_owner" });

    const res = await request("?service=postgres");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid log request" });
    expect(read).not.toHaveBeenCalled();
  });

  it("returns a generic 503 when logs are unavailable", async () => {
    vi.stubEnv("MATRIX_USER_ID", "user_owner");
    const read = vi.fn(async () => { throw new SystemLogsUnavailableError("failed"); });
    const { request } = appWith({ sub: "user_owner", read });

    const res = await request();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Logs are unavailable" });
  });

  it("returns 429 when too many log reads are in flight", async () => {
    vi.stubEnv("MATRIX_USER_ID", "user_owner");
    const read = vi.fn(async () => { throw new SystemLogsUnavailableError("busy"); });
    const { request } = appWith({ sub: "user_owner", read });

    expect((await request()).status).toBe(429);
  });
});
