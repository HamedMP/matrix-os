import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter.js";

class FakeStream extends EventEmitter {}

function child(stdoutText: string, exitCode = 0) {
  const stdout = new FakeStream();
  const stderr = new FakeStream();
  const process = new EventEmitter() as EventEmitter & {
    stdout: FakeStream;
    stderr: FakeStream;
    kill: ReturnType<typeof vi.fn>;
  };
  process.stdout = stdout;
  process.stderr = stderr;
  process.kill = vi.fn();
  queueMicrotask(() => {
    stdout.emit("data", Buffer.from(stdoutText));
    process.emit("exit", exitCode, null);
  });
  return process;
}

const baseInput = {
  owner: { type: "personal" as const, ownerId: "owner_hermes" },
  chatId: "chat_hermes",
  turnId: "cturn_hermes",
  runId: "run_hermes",
  prompt: "hello",
  parts: [{ type: "text" as const, text: "hello" }],
  selection: { instanceId: "hermes_default", model: "openai-codex:gpt-5.6-luna" },
  interactionMode: "default",
  permissionMode: "full_access",
  executionRoot: "/safe/project",
  signal: new AbortController().signal,
};

describe("Hermes canonical Chat Provider adapter", () => {
  it("runs the actual configured Hermes provider/model instead of Matrix kernel", async () => {
    const spawnFn = vi.fn(() => child("hello from hermes"));
    const readUsageFile = vi.fn(async () => ({ session_id: "hermes_session" }));
    const cleanupUsageFile = vi.fn(async () => undefined);
    const adapter = createHermesChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn,
      createUsageFile: vi.fn(async () => ({ directory: "/tmp/hermes-run", path: "/tmp/hermes-run/usage.json" })),
      readUsageFile,
      cleanupUsageFile,
    });

    const events = [];
    for await (const event of adapter.start(baseInput)) events.push(event);

    const [command, args, options] = spawnFn.mock.calls[0]!;
    expect(command).toBe("hermes");
    expect(args).toEqual(expect.arrayContaining([
      "-z", "hello",
      "--provider", "openai-codex",
      "--model", "gpt-5.6-luna",
      "--usage-file", "/tmp/hermes-run/usage.json",
      "--yolo",
    ]));
    expect(args).not.toContain("--source");
    expect(options).toMatchObject({ cwd: "/safe/project" });
    expect(events).toEqual([
      { type: "assistant.delta", delta: "hello from hermes" },
      { type: "state.updated", state: { sessionId: "hermes_session" } },
      { type: "run.completed", outcome: "completed" },
    ]);
    expect(cleanupUsageFile).toHaveBeenCalledWith("/tmp/hermes-run");
  });

  it("resumes only the persisted Hermes session", async () => {
    const spawnFn = vi.fn(() => child("continued"));
    const adapter = createHermesChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn,
      createUsageFile: vi.fn(async () => ({ directory: "/tmp/hermes-run", path: "/tmp/hermes-run/usage.json" })),
      readUsageFile: vi.fn(async () => ({ session_id: "hermes_session" })),
      cleanupUsageFile: vi.fn(async () => undefined),
    });
    const events = [];
    for await (const event of adapter.resume!({
      ...baseInput,
      resumeState: { sessionId: "hermes_session" },
    })) events.push(event);

    expect(spawnFn.mock.calls[0]![1]).toEqual(expect.arrayContaining(["--resume", "hermes_session"]));
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
  });

  it("rejects unsupported permission and malformed provider selections before spawn", async () => {
    const spawnFn = vi.fn(() => child("ignored"));
    const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });

    await expect(async () => {
      for await (const _event of adapter.start({ ...baseInput, permissionMode: "supervised" })) {}
    }).rejects.toThrow("Unsupported Hermes permission mode");
    await expect(async () => {
      for await (const _event of adapter.start({
        ...baseInput,
        selection: { instanceId: "hermes_default", model: "missing-separator" },
      })) {}
    }).rejects.toThrow("Unsupported Hermes model selection");
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
