import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexProviderControlPath,
  createCodexControlClient,
} from "../../packages/gateway/src/coding-agents/codex-control-client.js";

const cleanup: Array<() => Promise<void>> = [];
const socketTempRoot = process.platform === "darwin" ? "/tmp" : tmpdir();

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((remove) => remove()));
});

async function listen(homePath: string, sessionId: string, reply?: string, replyDelayMs = 0) {
  const path = codexProviderControlPath(homePath, sessionId);
  await mkdir(dirname(path), { recursive: true });
  const frames: unknown[] = [];
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
    });
    socket.on("end", () => {
      frames.push(JSON.parse(input));
      if (reply !== undefined) setTimeout(() => socket.end(reply), replyDelayMs);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(homePath, { recursive: true, force: true });
  });
  return frames;
}

describe("Codex control client", () => {
  it("allows a loaded Codex app-server more than two seconds to acknowledge steer", async () => {
    const homePath = await mkdtemp(join(socketTempRoot, "mx-control-delayed-steer-"));
    const sessionId = "sess_delayed_steer";
    await listen(homePath, sessionId, '{"ok":true}\n', 2_100);
    const client = createCodexControlClient({ homePath });

    await expect(client.steerTurn({
      sessionId,
      prompt: "Apply this while the current tool is still running.",
      clientRequestId: "req_delayed_steer_1",
    })).resolves.toBeUndefined();
  });

  it("submits bounded Turn, steer, interrupt, approval, and structured input frames", async () => {
    const homePath = await mkdtemp(join(socketTempRoot, "mx-control-"));
    const sessionId = "sess_thread_control_1";
    const frames = await listen(homePath, sessionId, '{"ok":true}\n');
    const client = createCodexControlClient({ homePath, timeoutMs: 1_000 });

    await client.submitTurn({
      sessionId,
      turnId: "turn_control_1",
      prompt: "Continue with the focused tests.",
      model: "openai/gpt-5.6-sol",
      modelOptions: [{ id: "effort", value: "high" }],
    });
    await client.interruptTurn({
      sessionId,
      clientRequestId: "req_control_1",
    });
    await client.steerTurn({
      sessionId,
      prompt: "Use the failing route test as the next constraint.",
      clientRequestId: "req_control_steer_1",
    });
    await client.submitApproval({
      sessionId,
      approvalId: "appr_codex_11111111111111111111111111111111",
      decision: "approve",
      clientRequestId: "req_control_approval_1",
    });
    await client.submitInput({
      sessionId,
      inputRequestId: "req_codex_22222222222222222222222222222222",
      structuredAnswers: {
        question_codex_333333333333333333333333: ["Minimal"],
      },
      clientRequestId: "req_control_input_1",
    });

    expect(frames).toEqual([
      {
        type: "turn",
        prompt: "Continue with the focused tests.",
        model: "openai/gpt-5.6-sol",
        modelOptions: [{ id: "effort", value: "high" }],
        clientRequestId: "req_control_1",
      },
      {
        type: "interrupt",
        clientRequestId: "req_control_1",
      },
      {
        type: "steer",
        prompt: "Use the failing route test as the next constraint.",
        clientRequestId: "req_control_steer_1",
      },
      {
        type: "approval",
        approvalId: "appr_codex_11111111111111111111111111111111",
        decision: "approve",
        clientRequestId: "req_control_approval_1",
      },
      {
        type: "input",
        requestId: "req_codex_22222222222222222222222222222222",
        structuredAnswers: {
          question_codex_333333333333333333333333: ["Minimal"],
        },
        clientRequestId: "req_control_input_1",
      },
    ]);
  });

  it("fails closed for absent sockets, malformed replies, and stalled peers", async () => {
    const absentHome = await mkdtemp(join(socketTempRoot, "mx-control-absent-"));
    cleanup.push(() => rm(absentHome, { recursive: true, force: true }));
    const absent = createCodexControlClient({ homePath: absentHome, timeoutMs: 100 });
    await expect(absent.submitApproval({
      sessionId: "sess_absent",
      approvalId: "appr_codex_11111111111111111111111111111111",
      decision: "decline",
      clientRequestId: "req_absent_1",
    })).rejects.toThrow("Codex control request failed");

    const malformedHome = await mkdtemp(join(socketTempRoot, "mx-control-malformed-"));
    await listen(malformedHome, "sess_malformed", '{"providerError":"/private/path"}\n');
    const malformed = createCodexControlClient({ homePath: malformedHome, timeoutMs: 100 });
    await expect(malformed.submitApproval({
      sessionId: "sess_malformed",
      approvalId: "appr_codex_11111111111111111111111111111111",
      decision: "decline",
      clientRequestId: "req_malformed_1",
    })).rejects.toThrow("Codex control request failed");

    const stalledHome = await mkdtemp(join(socketTempRoot, "mx-control-stalled-"));
    await listen(stalledHome, "sess_stalled");
    const stalled = createCodexControlClient({ homePath: stalledHome, timeoutMs: 25 });
    await expect(stalled.submitApproval({
      sessionId: "sess_stalled",
      approvalId: "appr_codex_11111111111111111111111111111111",
      decision: "decline",
      clientRequestId: "req_stalled_1",
    })).rejects.toThrow("Codex control request failed");
  });
});
