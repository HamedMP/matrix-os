import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createOutboundQueue,
  type OutboundQueue,
} from "../../packages/gateway/src/security/outbound-queue.js";

describe("T831: Outbound write-ahead queue", () => {
  let homePath: string;
  let queue: OutboundQueue;

  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), "outq-"));
    mkdirSync(join(homePath, "system"), { recursive: true });
    queue = createOutboundQueue(homePath);
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("enqueue persists to file before returning", () => {
    const id = queue.enqueue({
      channel: "telegram",
      target: "chat-123",
      content: "Hello",
    });
    expect(id).toBeTruthy();

    const fresh = createOutboundQueue(homePath);
    const pending = fresh.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe("Hello");
  });

  it("ack removes from queue", () => {
    const id = queue.enqueue({
      channel: "telegram",
      target: "chat-123",
      content: "Hello",
    });
    queue.ack(id);

    expect(queue.pending()).toHaveLength(0);
  });

  it("failed increments attempt count and preserves error", () => {
    const id = queue.enqueue({
      channel: "telegram",
      target: "chat-123",
      content: "Hello",
    });
    queue.failed(id, "Network timeout");

    const pending = queue.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].attempts).toBe(1);
    expect(pending[0].lastError).toBe("Network timeout");
  });

  it("queue survives simulated crash (read from file on restart)", () => {
    queue.enqueue({ channel: "telegram", target: "c1", content: "msg1" });
    queue.enqueue({ channel: "discord", target: "c2", content: "msg2" });

    const recovered = createOutboundQueue(homePath);
    const pending = recovered.pending();
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.content).sort()).toEqual(["msg1", "msg2"]);
  });

  it("respects max retry attempts", () => {
    const q = createOutboundQueue(homePath, { maxRetries: 2 });
    const id = q.enqueue({
      channel: "telegram",
      target: "c1",
      content: "retry me",
    });

    q.failed(id, "err1");
    q.failed(id, "err2");

    expect(q.pending()).toHaveLength(0);
  });
});
