import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentThreadSummarySchema } from "@matrix-os/contracts";
import { createChatDispatchTimer } from "../../packages/gateway/src/chat/send-timing.js";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import type { CodexControlClient } from "../../packages/gateway/src/coding-agents/codex-control-client.js";
import { createBackgroundAgentRuntime } from "../../packages/gateway/src/background-agent-runtime.js";

type TimingEvent = { runId?: string; driver?: string; stage: string; durationMs?: number };

function captureTimings() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    if (args[0] === "[chat-send-timing]") lines.push(String(args[1]));
  });
  return { lines, events: () => lines.map((line) => JSON.parse(line) as TimingEvent), restore: () => spy.mockRestore() };
}

const thread = AgentThreadSummarySchema.parse({ id: "thread_private", providerId: "codex", title: "Native", status: "running", attention: "none", createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z" });
const principal = { userId: "owner_private", source: "jwt" as const };
const binding = "a".repeat(64);

function provider() {
  const admission = { releaseStoppedSession: vi.fn(async () => undefined), releaseFailedStart: vi.fn(async () => undefined), prepareRevocation: vi.fn(async () => async () => undefined), validateLaunch: vi.fn(async () => undefined), start: vi.fn(async () => binding), validate: vi.fn(async () => undefined), renewStoppedSession: vi.fn() };
  const control = { submitTurn: vi.fn(async () => undefined), steerTurn: vi.fn(), submitApproval: vi.fn(), submitInput: vi.fn() };
  const runtime = { getSession: vi.fn(), startSession: vi.fn(async () => ({ ok: true as const, status: 201 as const, session: { runtime: { type: "background", status: "running" } } })), stopSession: vi.fn() };
  const events = { healthCheck: vi.fn(), watch: vi.fn(async () => ({})), unwatch: vi.fn(), markStopped: vi.fn() };
  return createWorkspaceCodingAgentProvider({ providerId: "codex", agent: "codex", runtime: runtime as never, codexEvents: events as never, codexControl: control as unknown as CodexControlClient, codexAdmission: admission as never });
}
const base = { principal, thread, now: () => new Date(), nextEventId: () => "evt_native" };

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

describe("Codex send launch sub-stage timings", () => {
  it("records nothing with the flag off, even inside a dispatch", async () => {
    const capture = captureTimings();
    try {
      await provider().startThread({ ...base, request: { providerId: "codex", prompt: "private prompt", clientRequestId: "req_private_off" } });
      expect(capture.lines).toEqual([]);
    } finally { capture.restore(); }
  });

  it("attributes first-turn admission, watch, and session start to the dispatch run", async () => {
    vi.stubEnv("MATRIX_CODEX_SEND_TIMINGS", "1");
    const capture = captureTimings();
    try {
      const timer = createChatDispatchTimer("run_timed", "codex");
      await timer.run(() => provider().startThread({ ...base, request: { providerId: "codex", prompt: "private prompt", clientRequestId: "req_private_start" } }));
      expect(capture.events().map(event => [event.runId, event.stage])).toEqual([
        ["run_timed", "codex_admission_start"], ["run_timed", "codex_events_watch"],
        ["run_timed", "codex_admission_validate"], ["run_timed", "session_start"],
      ]);
      expect(capture.lines.join(" ")).not.toMatch(/private|owner_private|sess_/);
    } finally { capture.restore(); }
  });

  it("attributes follow-up admission and submit to the dispatch run", async () => {
    vi.stubEnv("MATRIX_CODEX_SEND_TIMINGS", "1");
    const capture = captureTimings();
    try {
      const timer = createChatDispatchTimer("run_followup", "codex");
      await timer.run(() => provider().resumeTurn!({ ...base, resumeState: { conversationId: "sess_private", nativeAccountBinding: binding },
        signal: new AbortController().signal, turn: { turnId: "turn_private", message: "private follow-up" } }));
      expect(capture.events().map(event => event.stage)).toEqual([
        "codex_admission_validate", "codex_events_watch", "codex_admission_validate", "turn_submit",
      ]);
    } finally { capture.restore(); }
  });

  it("splits background launch into queue, lock, inventory, spawn, and active check", async () => {
    vi.stubEnv("MATRIX_CODEX_SEND_TIMINGS", "1");
    const homePath = await mkdtemp(join(tmpdir(), "matrix-substage-"));
    homes.push(homePath);
    const units = new Map<string, string>();
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command.endsWith("systemd-run")) units.set(args.find(a => a.startsWith("--unit="))!.slice(7), "active");
      if (args.includes("show")) return { stdout: args.filter(arg => arg.endsWith(".service")).map(name => `Id=${name}\nLoadState=loaded\nActiveState=${units.get(name) ?? "inactive"}\nSubState=running\n`).join("\n"), stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const runtime = createBackgroundAgentRuntime({ homePath, runCommand, withLock: async (_path, action) => action() });
    const capture = captureTimings();
    try {
      const timer = createChatDispatchTimer("run_background", "codex");
      await timer.run(() => runtime.start({ sessionId: "sess_private", launch: { command: "/usr/bin/node", args: ["runner.mjs"], env: {}, cwd: homePath } }));
      expect(capture.events().map(event => event.stage)).toEqual([
        "background_queue_wait", "background_flock", "background_inventory", "systemd_run_spawned", "unit_active",
      ]);
      expect(capture.lines.join(" ")).not.toContain(homePath);
    } finally { capture.restore(); await runtime.close(); }
  });
});
