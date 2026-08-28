import {
  CanonicalProviderCatalogSchema,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatExecutionRootResolver } from "../../packages/gateway/src/chat/execution-root.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import {
  CanonicalChatProviderRegistry,
  type CanonicalChatProviderAdapter,
} from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "owner_orchestrator" };
const principal = { userId: owner.ownerId, source: "jwt" as const };

function catalog(): CanonicalProviderCatalog {
  return CanonicalProviderCatalogSchema.parse({
    revision: "catalog_orchestrator",
    drivers: [{
      kind: "codex",
      displayName: "Codex",
      adapterVersion: "1.0.0",
      capabilityClass: "coding_agent",
    }],
    instances: [{
      id: "codex_default",
      driverKind: "codex",
      displayName: "Codex",
      availability: "available",
      workspaceRequirement: "project_optional",
      catalogRevision: "catalog_orchestrator",
      models: [{
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        availability: "available",
        capabilities: ["reasoning", "tools"],
        supportsVision: false,
        supportsToolUse: true,
      }],
      options: [],
      skills: [],
      commands: [],
      setupActions: [],
      supports: {
        rootChat: true,
        resume: true,
        cancellation: true,
        attachments: ["file", "image", "structured_ref"],
        tools: [],
        approvals: true,
        userInput: true,
        worktrees: "optional",
        resources: ["file", "folder", "project", "task", "app", "terminal_session"],
        interactionModes: ["default"],
        permissionModes: ["supervised"],
      },
    }],
  });
}

function adapter(
  start: CanonicalChatProviderAdapter<{ sessionId: string }>["start"],
): CanonicalChatProviderAdapter<{ sessionId: string }> {
  return {
    driverKind: "codex",
    stateSchemaVersion: 1,
    parseState(value) {
      if (!value || typeof value !== "object" || typeof (value as { sessionId?: unknown }).sessionId !== "string") {
        throw new Error("invalid state");
      }
      return value as { sessionId: string };
    },
    serializeState: (value) => value,
    start,
  };
}

describe("CanonicalChatOrchestrator", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
  });

  afterEach(async () => {
    await repository.kysely.destroy();
  });

  it("commits admission before Provider work, revalidates the root, and replays normalized output", async () => {
    await repository.create(owner, {
      id: "chat_orchestrated",
      clientRequestId: "req_create_orchestrated",
      title: "Orchestrated",
      projectId: "project_matrix",
    });
    const resolve = vi.fn(async () => ({
      ref: { kind: "project" as const, projectId: "project_matrix" },
      fingerprint: "a".repeat(64),
      primaryWorkspaceRoot: "/safe/project",
      projectSlug: "matrix-os",
    }));
    const revalidate = vi.fn(async (_owner, provenance) => ({
      ...provenance,
      primaryWorkspaceRoot: "/safe/project",
      projectSlug: "matrix-os",
    }));
    const roots: ChatExecutionRootResolver = { resolve, revalidate };
    const sawCommittedAdmission = vi.fn();
    const provider = adapter(async function* (input) {
      const snapshot = await repository.exportChat(owner, input.chatId);
      sawCommittedAdmission(snapshot?.runs[0]?.status, snapshot?.messages[0]?.role);
      expect(input.executionRoot).toBe("/safe/project");
      yield { type: "state.updated", state: { sessionId: "native_session" } };
      yield { type: "assistant.delta", delta: "hello" };
      yield { type: "assistant.delta", delta: " world" };
      yield { type: "run.completed", outcome: "completed" };
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([provider]),
      executionRoots: roots,
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });

    const admitted = await orchestrator.admitTurn(principal, owner, "chat_orchestrated", {
      clientRequestId: "req_orchestrated_turn",
      baseRevision: 0,
      parts: [{ type: "text", text: "hello" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
      executionRoot: { kind: "project", projectId: "project_matrix" },
    });
    expect(admitted).toMatchObject({ admission: "accepted", run: { status: "accepted" } });
    await orchestrator.drain();

    expect(sawCommittedAdmission).toHaveBeenCalledWith("running", "user");
    expect(resolve).toHaveBeenCalledWith(owner, { kind: "project", projectId: "project_matrix" });
    expect(revalidate).toHaveBeenCalledWith(owner, {
      ref: { kind: "project", projectId: "project_matrix" },
      fingerprint: "a".repeat(64),
    });
    const snapshot = await repository.exportChat(owner, "chat_orchestrated");
    expect(snapshot?.messages.map((message) => [message.role, message.state, message.parts]))
      .toEqual([
        ["user", "committed", [{ type: "text", text: "hello" }]],
        ["assistant", "committed", [{ type: "text", text: "hello world" }]],
      ]);
    expect(snapshot?.runs[0]).toMatchObject({
      status: "completed",
      outcome: "completed",
      executionRootFingerprint: "a".repeat(64),
    });
    expect(await repository.getAdapterState(owner, {
      runId: admitted.run.id,
      driverKind: "codex",
      instanceId: "codex_default",
    })).toEqual({ schemaVersion: 1, state: { sessionId: "native_session" } });
    expect(snapshot?.activities.map((activity) => activity.type)).toEqual([
      "run.status",
      "turn.status",
      "run.status",
    ]);
  });

  it("keeps one durable pending assistant message through 501 deltas and finalizes it in place", async () => {
    await repository.create(owner, {
      id: "chat_lossless_long_run",
      clientRequestId: "req_create_lossless_long_run",
      title: "Lossless long Run",
    });
    let releaseProvider!: () => void;
    let firstDeltaPersisted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      firstDeltaPersisted = resolve;
    });
    const provider = adapter(async function* () {
      yield { type: "assistant.delta", delta: "a" };
      firstDeltaPersisted();
      await release;
      for (let index = 0; index < 500; index += 1) {
        yield { type: "assistant.delta", delta: String(index % 10) };
      }
      yield { type: "run.completed", outcome: "completed" };
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([provider]),
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });

    const admitted = await orchestrator.admitTurn(principal, owner, "chat_lossless_long_run", {
      clientRequestId: "req_lossless_long_run_turn",
      baseRevision: 0,
      parts: [{ type: "text", text: "stream for a long time" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    });
    await paused;

    const pending = await repository.exportChat(owner, "chat_lossless_long_run");
    const pendingAssistant = pending?.messages.find((message) => message.role === "assistant");
    expect(pendingAssistant).toMatchObject({
      id: `msg_${admitted.run.id.slice("run_".length)}_assistant`,
      runId: admitted.run.id,
      state: "pending",
      parts: [{ type: "text", text: "a" }],
    });

    releaseProvider();
    await orchestrator.drain();

    const completed = await repository.exportChat(owner, "chat_lossless_long_run");
    const completedAssistant = completed?.messages.find((message) => message.role === "assistant");
    expect(completedAssistant).toMatchObject({
      id: pendingAssistant?.id,
      state: "committed",
      parts: [{
        type: "text",
        text: `a${Array.from({ length: 500 }, (_, index) => String(index % 10)).join("")}`,
      }],
    });
    expect(completed?.runs[0]).toMatchObject({ status: "completed", outcome: "completed" });
    expect(completed?.activities.map((activity) => activity.type)).toEqual([
      "run.status",
      "turn.status",
      "run.status",
    ]);
  });

  it("keeps durable partial assistant text when a Provider fails before completion", async () => {
    await repository.create(owner, {
      id: "chat_lossless_partial_failure",
      clientRequestId: "req_create_lossless_partial_failure",
      title: "Lossless partial failure",
    });
    const provider = adapter(async function* () {
      yield { type: "assistant.delta", delta: "Durable partial answer" };
      throw new Error("private Provider failure");
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([provider]),
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });

    const admitted = await orchestrator.admitTurn(principal, owner, "chat_lossless_partial_failure", {
      clientRequestId: "req_lossless_partial_failure_turn",
      baseRevision: 0,
      parts: [{ type: "text", text: "fail after partial output" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    });
    await orchestrator.drain();

    const reloaded = await repository.exportChat(owner, "chat_lossless_partial_failure");
    expect(reloaded?.messages.find((message) => message.runId === admitted.run.id)).toMatchObject({
      id: `msg_${admitted.run.id.slice("run_".length)}_assistant`,
      state: "failed",
      parts: [{ type: "text", text: "Durable partial answer" }],
    });
    expect(reloaded?.runs[0]).toMatchObject({ status: "failed", outcome: "failed" });
    expect(reloaded?.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run.error" }),
    ]));
  });

  it("does not reconcile a committed Run while its dispatch registration is pending", async () => {
    await repository.create(owner, {
      id: "chat_pending_dispatch",
      clientRequestId: "req_create_pending_dispatch",
      title: "Pending dispatch",
    });
    let releaseAdmission!: () => void;
    let admissionCommitted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const committed = new Promise<void>((resolve) => {
      admissionCommitted = resolve;
    });
    const delayedRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === "admitTurn") {
          return async (...args: Parameters<ChatRepository["admitTurn"]>) => {
            const admitted = await target.admitTurn(...args);
            admissionCommitted();
            await release;
            return admitted;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const start = vi.fn(async function* () {
      yield { type: "run.completed" as const, outcome: "completed" as const };
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository: delayedRepository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([adapter(start)]),
    });

    await orchestrator.reconcileActiveRuns(owner);
    for (let index = 1; index < 64; index += 1) {
      await orchestrator.reconcileActiveRuns({ type: "personal", ownerId: `owner_cache_${index}` });
    }

    const admission = orchestrator.admitTurn(principal, owner, "chat_pending_dispatch", {
      clientRequestId: "req_pending_dispatch_turn",
      baseRevision: 0,
      parts: [{ type: "text", text: "run safely" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    });
    await committed;
    await orchestrator.reconcileActiveRuns({ type: "personal", ownerId: "owner_cache_64" });
    expect(await orchestrator.reconcileActiveRuns(owner)).toBe(0);
    releaseAdmission();
    await admission;
    await orchestrator.drain();

    expect(start).toHaveBeenCalledTimes(1);
    expect((await repository.exportChat(owner, "chat_pending_dispatch"))?.runs[0])
      .toMatchObject({ status: "completed", outcome: "completed" });
  });

  it("rejects an execution root from another Project before resolution", async () => {
    await repository.create(owner, {
      id: "chat_wrong_project_root",
      clientRequestId: "req_create_wrong_project_root",
      title: "Wrong Project root",
      projectId: "project_matrix",
    });
    const resolve = vi.fn(async () => {
      throw new Error("wrong Project root must not resolve");
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([adapter(async function* () {
        yield { type: "run.completed", outcome: "completed" };
      })]),
      executionRoots: { resolve, revalidate: vi.fn() },
    });

    await expect(orchestrator.admitTurn(principal, owner, "chat_wrong_project_root", {
      clientRequestId: "req_wrong_project_root_turn",
      baseRevision: 0,
      parts: [{ type: "text", text: "wrong root" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
      executionRoot: { kind: "project", projectId: "project_other" },
    })).rejects.toMatchObject({ safeError: { code: "project_unavailable" }, status: 400 });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("starts a fresh Provider session when execution-root provenance changes", async () => {
    await repository.create(owner, {
      id: "chat_changed_root",
      clientRequestId: "req_create_changed_root",
      title: "Changed root",
      projectId: "project_matrix",
    });
    let fingerprint = "a".repeat(64);
    const roots: ChatExecutionRootResolver = {
      resolve: async (_owner, ref) => ({
        ref,
        fingerprint,
        primaryWorkspaceRoot: "/safe/project",
        projectSlug: "matrix-os",
      }),
      revalidate: async (_owner, provenance) => ({
        ref: provenance.ref,
        fingerprint: provenance.fingerprint,
        primaryWorkspaceRoot: "/safe/project",
        projectSlug: "matrix-os",
      }),
    };
    const start = vi.fn(async function* () {
      yield { type: "state.updated" as const, state: { sessionId: "native_root" } };
      yield { type: "run.completed" as const, outcome: "completed" as const };
    });
    const resume = vi.fn(async function* () {
      yield { type: "run.completed" as const, outcome: "completed" as const };
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([{ ...adapter(start), resume }]),
      executionRoots: roots,
    });

    await orchestrator.admitTurn(principal, owner, "chat_changed_root", {
      clientRequestId: "req_changed_root_first",
      baseRevision: 0,
      parts: [{ type: "text", text: "first" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    });
    await orchestrator.drain();
    const first = await repository.get(owner, "chat_changed_root");
    expect(first).not.toBeNull();
    fingerprint = "b".repeat(64);
    await orchestrator.admitTurn(principal, owner, "chat_changed_root", {
      clientRequestId: "req_changed_root_second",
      baseRevision: first!.chat.revision,
      parts: [{ type: "text", text: "second" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    });
    await orchestrator.drain();

    expect(start).toHaveBeenCalledTimes(2);
    expect(resume).not.toHaveBeenCalled();
  });

  it("aborts an active Run idempotently and does not persist late Provider output", async () => {
    await repository.create(owner, {
      id: "chat_cancelled",
      clientRequestId: "req_create_cancelled",
      title: "Cancelled",
    });
    let partialPersisted!: () => void;
    const persisted = new Promise<void>((resolve) => {
      partialPersisted = resolve;
    });
    const provider = adapter(async function* (input) {
      yield { type: "assistant.delta", delta: "durable partial before cancellation" };
      partialPersisted();
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "assistant.delta", delta: "late output" };
      yield { type: "run.completed", outcome: "aborted" };
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([provider]),
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });
    const admitted = await orchestrator.admitTurn(principal, owner, "chat_cancelled", {
      clientRequestId: "req_cancelled_turn",
      baseRevision: 0,
      parts: [{ type: "text", text: "wait" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    });
    await persisted;

    const cancelled = await orchestrator.cancelRun(owner, "chat_cancelled", admitted.run.id);
    expect(cancelled).toMatchObject({ cancellation: "aborted", run: { status: "aborted" } });
    const repeated = await orchestrator.cancelRun(owner, "chat_cancelled", admitted.run.id);
    expect(repeated).toMatchObject({ cancellation: "already_terminal", run: { status: "aborted" } });
    await orchestrator.drain();

    const snapshot = await repository.exportChat(owner, "chat_cancelled");
    expect(snapshot?.messages).toHaveLength(2);
    expect(snapshot?.messages.find((message) => message.runId === admitted.run.id)).toMatchObject({
      state: "failed",
      parts: [{ type: "text", text: "durable partial before cancellation" }],
    });
    expect(snapshot?.runs[0]).toMatchObject({ status: "aborted", outcome: "aborted" });
    expect(snapshot?.activities.some((activity) =>
      activity.type === "assistant.delta" && activity.delta === "late output"
    )).toBe(false);
  });

  it("resumes later Turns only through the same adapter state schema and Instance", async () => {
    await repository.create(owner, {
      id: "chat_resumed",
      clientRequestId: "req_create_resumed",
      title: "Resumed",
    });
    const start = vi.fn(async function* () {
      yield { type: "state.updated" as const, state: { sessionId: "native_resume" } };
      yield { type: "assistant.delta" as const, delta: "first" };
      yield { type: "run.completed" as const, outcome: "completed" as const };
    });
    const resume = vi.fn(async function* (input) {
      expect(input.resumeState).toEqual({ sessionId: "native_resume" });
      yield { type: "assistant.delta" as const, delta: "second" };
      yield { type: "run.completed" as const, outcome: "completed" as const };
    });
    const provider = { ...adapter(start), resume };
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([provider]),
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });

    await orchestrator.admitTurn(principal, owner, "chat_resumed", {
      clientRequestId: "req_resumed_first",
      baseRevision: 0,
      parts: [{ type: "text", text: "first" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    });
    await orchestrator.drain();
    const afterFirst = await repository.get(owner, "chat_resumed");
    expect(afterFirst).not.toBeNull();

    await orchestrator.admitTurn(principal, owner, "chat_resumed", {
      clientRequestId: "req_resumed_second",
      baseRevision: afterFirst!.chat.revision,
      parts: [{ type: "text", text: "second" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    });
    await orchestrator.drain();

    expect(start).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    const snapshot = await repository.exportChat(owner, "chat_resumed");
    expect(snapshot?.messages.flatMap((message) =>
      message.parts.flatMap((part) => part.type === "text" ? [part.text] : [])
    )).toEqual(["first", "first", "second", "second"]);
    expect(snapshot?.runs).toHaveLength(2);
    expect(new Set(snapshot?.runs.map((run) => run.instanceId))).toEqual(new Set(["codex_default"]));
  });

  it("retries the same Turn as a new auditable Run without reusing failed output as input", async () => {
    await repository.create(owner, {
      id: "chat_retried",
      clientRequestId: "req_create_retried",
      title: "Retried",
    });
    let attempt = 0;
    const provider = adapter(async function* () {
      attempt += 1;
      yield { type: "assistant.delta", delta: attempt === 1 ? "partial" : "recovered" };
      yield { type: "run.completed", outcome: attempt === 1 ? "failed" : "completed" };
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([provider]),
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });

    const first = await orchestrator.admitTurn(principal, owner, "chat_retried", {
      clientRequestId: "req_retried_turn",
      baseRevision: 0,
      parts: [{ type: "text", text: "try once" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    });
    await orchestrator.drain();
    const failed = await repository.get(owner, "chat_retried");
    expect(failed).not.toBeNull();

    const retried = await orchestrator.retryTurn(
      principal,
      owner,
      "chat_retried",
      first.turn.id,
      { clientRequestId: "req_retried_attempt_2", baseRevision: failed!.chat.revision },
    );
    expect(retried).toMatchObject({ admission: "accepted", run: { attempt: 2, status: "accepted" } });
    await orchestrator.drain();

    const snapshot = await repository.exportChat(owner, "chat_retried");
    expect(snapshot?.turns).toHaveLength(1);
    expect(snapshot?.runs.map((run) => [run.attempt, run.status])).toEqual([
      [1, "failed"],
      [2, "completed"],
    ]);
    expect(snapshot?.messages.map((message) => [message.seq, message.role, message.state])).toEqual([
      [1, "user", "committed"],
      [2, "assistant", "failed"],
      [3, "assistant", "committed"],
    ]);
  });

  it("reconciles accepted Runs after Gateway restart instead of guessing that a Provider is live", async () => {
    await repository.create(owner, {
      id: "chat_restarted",
      clientRequestId: "req_create_restarted",
      title: "Restarted",
    });
    const inputMessage = {
      id: "msg_restarted",
      chatId: "chat_restarted",
      seq: 1,
      role: "user" as const,
      state: "committed" as const,
      turnId: "cturn_restarted",
      parts: [{ type: "text" as const, text: "continue after restart" }],
      createdAt: "2026-08-26T00:00:00.000Z",
    };
    const inputTurn = {
      id: "cturn_restarted",
      chatId: "chat_restarted",
      clientRequestId: "req_restarted_turn",
      baseMessageSeq: 0,
      inputMessageId: inputMessage.id,
      status: "accepted" as const,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    };
    await repository.admitTurn(owner, {
      chatId: "chat_restarted",
      baseRevision: 0,
      message: inputMessage,
      turn: inputTurn,
      run: {
        id: "run_restarted",
        chatId: "chat_restarted",
        turnId: inputTurn.id,
        attempt: 1,
        driverKind: "codex",
        instanceId: "codex_default",
        selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
        interactionMode: "default",
        permissionMode: "supervised",
        status: "accepted",
        historyBoundarySeq: 0,
        capabilitySnapshot: catalog().instances[0]!.supports && {
          revision: "catalog_orchestrator",
          ...catalog().instances[0]!.supports,
        },
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      },
    });
    const restarted = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([]),
      now: () => new Date("2026-08-26T00:02:00.000Z"),
    });

    expect(await restarted.reconcileActiveRuns(owner)).toBe(1);
    const snapshot = await repository.exportChat(owner, "chat_restarted");
    expect(snapshot?.runs[0]).toMatchObject({ status: "failed", outcome: "failed" });
    expect(snapshot?.activities).toEqual([
      expect.objectContaining({
        type: "run.error",
        error: expect.objectContaining({ retryable: true, recoveryActions: ["retry"] }),
      }),
    ]);
  });

  it("terminalizes an orphaned Run when its activity history is already full", async () => {
    await repository.create(owner, {
      id: "chat_reconcile_overflow",
      clientRequestId: "req_create_reconcile_overflow",
      title: "Reconcile overflow",
    });
    const inputMessage = {
      id: "msg_reconcile_overflow",
      chatId: "chat_reconcile_overflow",
      seq: 1,
      role: "user" as const,
      state: "committed" as const,
      turnId: "cturn_reconcile_overflow",
      parts: [{ type: "text" as const, text: "continue after restart" }],
      createdAt: "2026-08-26T00:00:00.000Z",
    };
    const inputTurn = {
      id: "cturn_reconcile_overflow",
      chatId: "chat_reconcile_overflow",
      clientRequestId: "req_reconcile_overflow_turn",
      baseMessageSeq: 0,
      inputMessageId: inputMessage.id,
      status: "accepted" as const,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    };
    const admitted = await repository.admitTurn(owner, {
      chatId: "chat_reconcile_overflow",
      baseRevision: 0,
      message: inputMessage,
      turn: inputTurn,
      run: {
        id: "run_reconcile_overflow",
        chatId: "chat_reconcile_overflow",
        turnId: inputTurn.id,
        attempt: 1,
        driverKind: "codex",
        instanceId: "codex_default",
        selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
        interactionMode: "default",
        permissionMode: "supervised",
        status: "accepted",
        historyBoundarySeq: 0,
        capabilitySnapshot: catalog().instances[0]!.supports && {
          revision: "catalog_orchestrator",
          ...catalog().instances[0]!.supports,
        },
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      },
    });
    for (let offset = 0; offset < 500; offset += 100) {
      await repository.appendRunActivities(owner, admitted.chat.chat.id, admitted.run.id,
        Array.from({ length: 100 }, (_, index) => ({
          id: `activity_reconcile_overflow_${offset + index}`,
          chatId: admitted.chat.chat.id,
          runId: admitted.run.id,
          occurredAt: "2026-08-26T00:01:00.000Z",
          type: "run.status" as const,
          status: "running" as const,
        })),
      );
    }
    const restarted = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([]),
      now: () => new Date("2026-08-26T00:02:00.000Z"),
    });

    expect(await restarted.reconcileActiveRuns(owner)).toBe(1);
    const snapshot = await repository.exportChat(owner, "chat_reconcile_overflow");
    expect(snapshot?.runs[0]).toMatchObject({ status: "failed", outcome: "failed" });
    expect(snapshot?.activities).toHaveLength(500);
    expect(snapshot?.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run.error" }),
    ]));
  });

  it("limits one owner to eight concurrent Runs without consuming the global registry", async () => {
    const provider = adapter(async function* (input) {
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "run.completed", outcome: "aborted" };
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([provider]),
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });
    for (let index = 0; index < 9; index += 1) {
      await repository.create(owner, {
        id: `chat_concurrent_${index}`,
        clientRequestId: `req_create_concurrent_${index}`,
        title: `Concurrent ${index}`,
      });
    }
    for (let index = 0; index < 8; index += 1) {
      await orchestrator.admitTurn(principal, owner, `chat_concurrent_${index}`, {
        clientRequestId: `req_concurrent_turn_${index}`,
        baseRevision: 0,
        parts: [{ type: "text", text: `run ${index}` }],
        selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
        interactionMode: "default",
        permissionMode: "supervised",
      });
    }

    try {
      await expect(orchestrator.admitTurn(principal, owner, "chat_concurrent_8", {
        clientRequestId: "req_concurrent_turn_8",
        baseRevision: 0,
        parts: [{ type: "text", text: "run 8" }],
        selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
        interactionMode: "default",
        permissionMode: "supervised",
      })).rejects.toMatchObject({ safeError: { code: "run_unavailable" }, status: 503 });
    } finally {
      await orchestrator.close();
    }
    const rejected = await repository.exportChat(owner, "chat_concurrent_8");
    expect(rejected?.runs[0]).toMatchObject({ status: "failed", outcome: "failed" });
  });

  it("commits successful output at the former text-delta activity boundary", async () => {
    await repository.create(owner, {
      id: "chat_terminal_activity_overflow",
      clientRequestId: "req_create_terminal_activity_overflow",
      title: "Terminal activity overflow",
    });
    const provider = adapter(async function* () {
      for (let index = 0; index < 498; index += 1) {
        yield { type: "assistant.delta", delta: "x" };
      }
      yield { type: "run.completed", outcome: "completed" };
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([provider]),
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });

    await orchestrator.admitTurn(principal, owner, "chat_terminal_activity_overflow", {
      clientRequestId: "req_terminal_activity_overflow_turn",
      baseRevision: 0,
      parts: [{ type: "text", text: "finish at the activity boundary" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    });
    await orchestrator.drain();

    const snapshot = await repository.exportChat(owner, "chat_terminal_activity_overflow");
    expect(snapshot?.runs[0]).toMatchObject({ status: "completed", outcome: "completed" });
    expect(snapshot?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", state: "committed", parts: [{ type: "text", text: "x".repeat(498) }] }),
    ]));
    expect(snapshot?.activities).toHaveLength(3);
  });

  it("terminalizes a Run when semantic activity exceeds the persisted limit", async () => {
    await repository.create(owner, {
      id: "chat_activity_overflow",
      clientRequestId: "req_create_activity_overflow",
      title: "Activity overflow",
    });
    const provider = adapter(async function* () {
      for (let index = 0; index < 501; index += 1) {
        yield {
          type: "tool.progress",
          toolCallId: `tool_${index}`,
          label: `Tool ${index}`,
          status: "running",
        };
      }
      yield { type: "run.completed", outcome: "completed" };
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([provider]),
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });

    await orchestrator.admitTurn(principal, owner, "chat_activity_overflow", {
      clientRequestId: "req_activity_overflow_turn",
      baseRevision: 0,
      parts: [{ type: "text", text: "overflow" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    });
    await orchestrator.drain();

    const snapshot = await repository.exportChat(owner, "chat_activity_overflow");
    expect(snapshot?.runs[0]).toMatchObject({ status: "failed", outcome: "failed" });
    expect(snapshot?.activities.length).toBeLessThanOrEqual(500);
    expect(snapshot?.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run.error" }),
    ]));
    expect(orchestrator.activeCount).toBe(0);
  });

  it("bounds shutdown even when a Provider ignores cancellation", async () => {
    await repository.create(owner, {
      id: "chat_shutdown",
      clientRequestId: "req_create_shutdown",
      title: "Shutdown",
    });
    const provider = {
      ...adapter(async function* () {
        await new Promise<void>(() => undefined);
        yield { type: "run.completed", outcome: "completed" };
      }),
      cancel: vi.fn(async () => new Promise<void>(() => undefined)),
    };
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => catalog() },
      adapters: new CanonicalChatProviderRegistry([provider]),
      shutdownDrainMs: 20,
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    });
    await orchestrator.admitTurn(principal, owner, "chat_shutdown", {
      clientRequestId: "req_shutdown_turn",
      baseRevision: 0,
      parts: [{ type: "text", text: "hang" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    });

    const startedAt = Date.now();
    const closed = await Promise.race([
      orchestrator.close().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(closed).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(500);
    const snapshot = await repository.exportChat(owner, "chat_shutdown");
    expect(snapshot?.runs[0]).toMatchObject({ status: "aborted", outcome: "aborted" });
  });
});
