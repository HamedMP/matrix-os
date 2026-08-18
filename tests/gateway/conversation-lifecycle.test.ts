import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationLifecycle } from
  "../../packages/gateway/src/conversation-lifecycle.js";
import { createConversationMutationLock } from
  "../../packages/gateway/src/conversation-mutation-lock.js";
import { ConversationRunRegistry } from
  "../../packages/gateway/src/conversation-run-registry.js";
import { createConversationStore } from
  "../../packages/gateway/src/conversations.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("conversation lifecycle", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), "conversation-lifecycle-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  function setup() {
    const mutationLock = createConversationMutationLock({ maxKeys: 4 });
    const conversations = createConversationStore(homePath, { mutationLock });
    const conversationRuns = new ConversationRunRegistry();
    const lifecycle = createConversationLifecycle({
      mutationLock,
      conversations,
      conversationRuns,
    });
    return { mutationLock, conversations, conversationRuns, lifecycle };
  }

  it("keeps a deleted conversation deleted when delete wins admission", async () => {
    const { mutationLock, conversations, lifecycle } = setup();
    const id = conversations.create();
    const gate = deferred();
    const blocker = mutationLock.run(id, async () => gate.promise);

    const deletion = lifecycle.deleteIfIdle(id);
    const admission = lifecycle.admitExisting(id);
    gate.resolve();

    await expect(Promise.all([blocker, deletion, admission])).resolves.toEqual([
      undefined,
      "deleted",
      "not_found",
    ]);
    expect(conversations.get(id)).toBeNull();
  });

  it("rejects delete when existing-session admission wins", async () => {
    const { mutationLock, conversations, conversationRuns, lifecycle } = setup();
    const id = conversations.create();
    const gate = deferred();
    const blocker = mutationLock.run(id, async () => gate.promise);

    const admission = lifecycle.admitExisting(id);
    const deletion = lifecycle.deleteIfIdle(id);
    gate.resolve();

    await expect(Promise.all([blocker, admission, deletion])).resolves.toEqual([
      undefined,
      "admitted",
      "busy",
    ]);
    expect(conversationRuns.isActive(id)).toBe(true);
    expect(conversations.get(id)).not.toBeNull();
  });

  it("rejects duplicate admission without restarting the active run", async () => {
    const { conversations, lifecycle } = setup();
    const id = conversations.create();

    await expect(lifecycle.admitExisting(id)).resolves.toBe("admitted");
    await expect(lifecycle.admitExisting(id)).resolves.toBe("busy");
  });

  it("prepares project context under the admission lock before registering the run", async () => {
    const { conversations, conversationRuns, lifecycle } = setup();
    const id = conversations.create();
    await conversations.updateContext(id, "matrix-os");
    const states: boolean[] = [];

    const admission = await lifecycle.admitExistingPrepared(id, async (conversation) => {
      states.push(conversationRuns.isActive(id));
      return conversation.context?.projectId === "matrix-os"
        ? { workingDirectory: "/validated/matrix-os" }
        : null;
    });

    expect(admission).toEqual({
      status: "admitted",
      prepared: { workingDirectory: "/validated/matrix-os" },
    });
    expect(states).toEqual([false]);
    expect(conversationRuns.isActive(id)).toBe(true);
  });

  it("does not register a run when project context preparation is unavailable", async () => {
    const { conversations, conversationRuns, lifecycle } = setup();
    const id = conversations.create();

    await expect(
      lifecycle.admitExistingPrepared(id, async () => null),
    ).resolves.toEqual({ status: "unavailable" });
    expect(conversationRuns.isActive(id)).toBe(false);
  });

  it("completes the run only after finalization persists buffered text", async () => {
    const { conversations, conversationRuns, lifecycle } = setup();
    const id = conversations.create();
    await lifecycle.admitExisting(id);
    conversations.appendAssistantText(id, "finished response");

    await lifecycle.finalize(id);

    expect(conversationRuns.isActive(id)).toBe(false);
    expect(conversations.get(id)?.messages.at(-1)?.content).toBe("finished response");
  });
});
