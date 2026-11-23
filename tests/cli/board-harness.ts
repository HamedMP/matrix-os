import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { BoardDeps } from "../../packages/sync-client/src/cli/board-cli-support.js";

export const TASK_ID = "msg_task0000000001";
export const ROOT_ID = "msg_root0000000001";
export const REPLY_ID = "msg_reply000000001";
export const TOKEN = "c".repeat(64);
export const PANE_ENV = { ZELLIJ_SESSION_NAME: `matrix-rt_${"b".repeat(32)}`, ZELLIJ_PANE_ID: "7" };

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function boardError(reason: string, status: number, error = "Board said no.", next?: string): Response {
  return json({ error, reason, ...(next ? { next } : {}) }, status);
}

const homes: string[] = [];

export async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "matrix-board-cli-"));
  homes.push(home);
  return home;
}

export async function cleanupHomes(): Promise<void> {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>;

/** A fake gateway: records every request and answers with `respond`. */
export async function harness(respond: Responder, options: { env?: NodeJS.ProcessEnv; local?: boolean; home?: string } = {}) {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const home = options.home ?? await tempHome();
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)
      .map(([key, value]) => [key.toLowerCase(), value]));
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (!(init?.signal instanceof AbortSignal)) throw new Error("request sent without an abort signal");
    return respond(call);
  });
  const deps: Partial<BoardDeps> = {
    env: options.env ?? {},
    home,
    fetch: fetchImpl as unknown as typeof fetch,
    io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    resolveConnection: async () => ({ gatewayUrl: "http://127.0.0.1:4000", token: "tok", local: options.local ?? false }),
  };
  return { calls, out, err, home, deps, fetch: fetchImpl };
}

export const claimBody = (overrides: Record<string, unknown> = {}) => ({
  claim: {
    taskId: TASK_ID,
    epoch: 3,
    token: TOKEN,
    task: { state: "claimed", leaseUntil: "2026-11-20T10:05:00.000Z", epoch: 3, needs: [] },
    ...overrides,
  },
});
