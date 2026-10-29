import type { ChatGptPlanAuthority } from "../../../packages/gateway/src/bots/chatgpt-plan.js";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createBotRoutineApprovals } from "../../../packages/gateway/src/bots/routine-approval.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotRoutinesRepository } from "../../../packages/gateway/src/bots/repositories/routines.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotInteractionService } from "../../../packages/gateway/src/bots/interactions.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { BOT, OWNER, NOW, createBotStateDatabase, insertChat } from "./bot-state-support.js";
const CHAT = "chat_routine_approval",
  subscription = {
    accountId: "fixture-account",
    computerId: "fixture-computer",
    grantRevision: 3,
    peerId: "f2b7ba8f-009b-4603-8967-c3e6bdfb276e"
  };
const proposal = {
  name: "Fixture brief",
  prompt: "Summarize approved fixtures",
  schedule: {
    kind: "interval",
    everyMs: 60000
  },
  selection: {
    instanceId: "matrix_chatgpt_plan",
    model: "fixture-model"
  },
  authorizedEffects: ["read"]
};
let data: Awaited<ReturnType<typeof createBotStateDatabase>>, binding: BotRuntimeBinding;
beforeEach(async () => {
  data = await createBotStateDatabase();
  await insertChat(data.db, CHAT);
  await createBotBindingsRepository(data.db).bindDirect({
    ownerId: OWNER,
    botId: BOT,
    chatId: CHAT,
    now: NOW
  });
  const tasks = createBotTasksRepository(data.db),
    task = await tasks.create({
      ownerId: OWNER,
      botId: BOT,
      chatId: CHAT,
      now: NOW
    });
  await tasks.transition({
    ownerId: OWNER,
    taskId: task.taskId,
    baseRevision: task.revision,
    to: "running",
    runId: "run_proposal_fixture",
    now: NOW
  });
  binding = {
    runtimeHandle: "runtime_" + "f".repeat(32),
    executionGeneration: "1",
    ownerId: OWNER,
    botId: BOT,
    chatId: CHAT,
    taskId: task.taskId,
    runId: "run_proposal_fixture",
    rootFingerprint: "a".repeat(64),
    route: {
      api: "openai-responses",
      modelId: "fixture-model",
      input: ["text"],
      contextWindow: 1000,
      maxOutputTokens: 100
    },
    accessSourceId: "matrix_chatgpt_plan",
    subscription,
    capabilities: [],
    requestClass: "interactive"
  };
});
afterEach(async () => {
  await data?.destroy();
});
function setup() {
  const resolve = vi.fn<ChatGptPlanAuthority["resolve"]>(async () => ({
    route: binding.route,
    accessSourceId: "matrix_chatgpt_plan",
    subscription
  }));
  const transact = createBotStateTransactions(new ChatRepository(data.db as never));
  const service = createBotRoutineApprovals({
    db: data.db,
    transact,
    source: {
      resolve
    } as never,
    definitionRevision: async () => 1,
    now: () => new Date(NOW)
  });
  const interactions = createBotInteractionService({
    transact,
    now: () => new Date(NOW),
    handlers: {
      chooseAccount: async () => {
        throw new Error("unavailable fixture");
      },
      decideApproval: service.decide
    }
  });
  return {
    service,
    interactions,
    resolve,
    repo: createBotRoutinesRepository(data.db)
  };
}
it("only activates the exact proposal after the owner decides, once", async () => {
  const {
    service,
    interactions,
    resolve,
    repo
  } = setup();
  const pending = await service.propose(binding, proposal);
  expect(await repo.list(OWNER, BOT)).toEqual([]);
  const record = await createBotInteractionsRepository(data.db).get({
    ownerId: OWNER,
    interactionId: pending.interactionId
  });
  expect(record!.payload).toMatchObject({
    kind: "approval",
    tool: "routine.activate",
    policyRevision: 3
  });
  expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
    options: [{
      id: "accountId",
      value: "fixture-account"
    }, {
      id: "grantRevision",
      value: "3"
    }]
  }), OWNER, "background");
  const request = {
    kind: "approval",
    decision: "approve",
    baseRevision: record!.revision
  };
  await interactions.resolve(OWNER, CHAT, pending.interactionId, request);
  await interactions.resolve(OWNER, CHAT, pending.interactionId, request);
  const saved = await repo.list(OWNER, BOT);
  expect(saved).toHaveLength(1);
  expect(saved[0].authorization).toMatchObject({
    accountId: subscription.accountId,
    grantRevision: 3,
    computerId: subscription.computerId,
    definitionRevision: 1
  });
  expect(await service.authorize(saved[0])).toBe(true);
});
it("refuses background-consent failure and never creates an approval or routine", async () => {
  const {
    service,
    resolve,
    repo
  } = setup();
  resolve.mockRejectedValue(new Error("fixture consent unavailable"));
  await expect(service.propose(binding, proposal)).rejects.toMatchObject({
    code: "invalid_input"
  });
  expect(await repo.list(OWNER, BOT)).toEqual([]);
  expect(await data.db.selectFrom("bot_approvals").selectAll().execute()).toEqual([]);
});
it("refuses tampered timing or effects even when the approval ID is valid", async () => {
  const {
      service,
      interactions,
      repo
    } = setup(),
    pending = await service.propose(binding, proposal);
  const record = await createBotInteractionsRepository(data.db).get({
    ownerId: OWNER,
    interactionId: pending.interactionId
  });
  const payload = record!.payload as Record<string, unknown>,
    envelope = JSON.parse(payload.preview as string);
  envelope.proposal.authorizedEffects = ["send"];
  await data.db.updateTable("bot_interactions").set({
    payload: JSON.stringify({
      ...payload,
      preview: JSON.stringify(envelope)
    })
  }).where("interaction_id", "=", pending.interactionId).execute();
  await expect(interactions.resolve(OWNER, CHAT, pending.interactionId, {
    kind: "approval",
    decision: "approve",
    baseRevision: record!.revision
  })).rejects.toThrow();
  expect(await repo.list(OWNER, BOT)).toEqual([]);
});
it("keeps the original exact grant after activation and fails closed on revocation", async () => {
  const {
      service,
      interactions,
      resolve,
      repo
    } = setup(),
    pending = await service.propose(binding, proposal);
  const record = await createBotInteractionsRepository(data.db).get({
    ownerId: OWNER,
    interactionId: pending.interactionId
  });
  await interactions.resolve(OWNER, CHAT, pending.interactionId, {
    kind: "approval",
    decision: "approve",
    baseRevision: record!.revision
  });
  const [r] = await repo.list(OWNER, BOT);
  resolve.mockResolvedValue({
    route: binding.route,
    accessSourceId: "matrix_chatgpt_plan",
    subscription: {
      ...subscription,
      grantRevision: 4
    }
  });
  expect(await service.authorize(r)).toBe(false);
  expect(resolve.mock.calls.at(-1)?.[0]).toMatchObject({
    options: [{
      id: "accountId",
      value: "fixture-account"
    }, {
      id: "grantRevision",
      value: "3"
    }]
  });
});
it("denial, a foreign responder, and a background attempt never activate routines", async () => {
  const {
      service,
      interactions,
      repo
    } = setup(),
    pending = await service.propose(binding, proposal);
  const record = await createBotInteractionsRepository(data.db).get({
    ownerId: OWNER,
    interactionId: pending.interactionId
  });
  await expect(interactions.resolve("foreign", CHAT, pending.interactionId, {
    kind: "approval",
    decision: "approve",
    baseRevision: record!.revision
  })).rejects.toMatchObject({
    code: "not_found"
  });
  await interactions.resolve(OWNER, CHAT, pending.interactionId, {
    kind: "approval",
    decision: "deny",
    baseRevision: record!.revision
  });
  await expect(service.propose({
    ...binding,
    requestClass: "background"
  }, proposal)).rejects.toMatchObject({
    code: "invalid_input"
  });
  expect(await repo.list(OWNER, BOT)).toEqual([]);
});
async function activated(options: {
  dispatch?: boolean;
  recurring?: boolean;
} = {}) {
  const context = setup(),
    pending = await context.service.propose(binding, proposal);
  const record = await createBotInteractionsRepository(data.db).get({
    ownerId: OWNER,
    interactionId: pending.interactionId
  });
  await context.interactions.resolve(OWNER, CHAT, pending.interactionId, {
    kind: "approval",
    decision: "approve",
    baseRevision: record!.revision
  });
  const [r] = await context.repo.list(OWNER, BOT),
    at = r.nextFireAt!;
  const f = (await context.repo.claim({
    ownerId: OWNER,
    routineId: r.routineId,
    scheduledFor: at,
    nextFireAt: options.recurring ? new Date(Date.parse(at) + 60000).toISOString() : null,
    now: at
  }))!;
  if (options.dispatch !== false) await context.repo.dispatch({
    ownerId: OWNER,
    fireId: f.fireId,
    now: at
  });
  return {
    ...context,
    r,
    f,
    at
  };
}
async function admitFixture(fireId: string) {
  const repository = new ChatRepository(data.db as never),
    owner = {
      type: "personal" as const,
      ownerId: OWNER
    },
    record = await repository.get(owner, CHAT);
  const turnId = "cturn_routine_fixture",
    runId = "run_routine_fixture",
    messageId = "msg_routine_fixture";
  const capabilitySnapshot = {
    revision: "fixture",
    rootChat: true,
    attachments: [],
    resources: [],
    tools: [],
    approvals: true,
    userInput: true,
    resume: false,
    cancellation: true,
    worktrees: "none" as const,
    interactionModes: ["default"],
    permissionModes: ["default"]
  };
  await repository.admitTurn(owner, {
    chatId: CHAT,
    baseRevision: record!.chat.revision,
    message: {
      id: messageId,
      chatId: CHAT,
      turnId,
      seq: 1,
      role: "user",
      state: "committed",
      parts: [{
        type: "text",
        text: "forged text must not execute"
      }],
      createdAt: NOW
    },
    turn: {
      id: turnId,
      chatId: CHAT,
      clientRequestId: "req_routine_" + fireId,
      baseMessageSeq: 0,
      inputMessageId: messageId,
      status: "accepted",
      createdAt: NOW,
      updatedAt: NOW
    },
    run: {
      id: runId,
      chatId: CHAT,
      turnId,
      attempt: 1,
      driverKind: "matrix_bot",
      instanceId: "matrix_bot_default",
      selection: {
        instanceId: "matrix_bot_default",
        model: "auto"
      },
      interactionMode: "default",
      permissionMode: "default",
      status: "accepted",
      historyBoundarySeq: 0,
      capabilitySnapshot,
      createdAt: NOW,
      updatedAt: NOW
    }
  });
  return {
    repository,
    owner,
    chatId: CHAT,
    runId
  };
}
it("correlates the canonical run to one approved fire and restores the exact approved input", async () => {
  const {
    createBotRoutineExecution
  } = await import("../../../packages/gateway/src/bots/routine-execution.js");
  const {
      service,
      r,
      f,
      at
    } = await activated(),
    input = await admitFixture(f.fireId);
  const execution = createBotRoutineExecution({
    db: data.db,
    approvals: service,
    now: () => new Date(at)
  });
  const plan = await execution.prepareRun(input);
  expect(plan).toMatchObject({
    backgroundTaskId: f.taskId,
    text: proposal.prompt,
    selection: {
      instanceId: "matrix_chatgpt_plan",
      model: proposal.selection.model,
      options: [{
        id: "accountId",
        value: "fixture-account"
      }, {
        id: "grantRevision",
        value: "3"
      }]
    }
  });
  await expect(execution.prepareRun({
    ...input,
    owner: {
      type: "personal",
      ownerId: "foreign"
    }
  })).rejects.toThrow();
  const task = await createBotTasksRepository(data.db).get({
    ownerId: OWNER,
    taskId: f.taskId
  });
  await createBotTasksRepository(data.db).transition({
    ownerId: OWNER,
    taskId: f.taskId,
    baseRevision: task!.revision,
    to: "running",
    runId: input.runId,
    now: at
  });
  await execution.completeRun(input, {
    status: "completed"
  });
  expect((await createBotRoutinesRepository(data.db).fires(OWNER, r.routineId))[0].status).toBe("completed");
});
it("enforces the approved effect envelope on every background tool boundary", async () => {
  const {
    createBotRoutineExecution
  } = await import("../../../packages/gateway/src/bots/routine-execution.js");
  const {
      service,
      f,
      at
    } = await activated(),
    execution = createBotRoutineExecution({
      db: data.db,
      approvals: service,
      now: () => new Date(at)
    });
  const task = await createBotTasksRepository(data.db).get({
    ownerId: OWNER,
    taskId: f.taskId
  });
  await createBotTasksRepository(data.db).transition({
    ownerId: OWNER,
    taskId: f.taskId,
    baseRevision: task!.revision,
    to: "running",
    runId: "run_background_fixture",
    now: at
  });
  const run = {
    ...binding,
    taskId: f.taskId,
    runId: "run_background_fixture",
    requestClass: "background" as const
  };
  await expect(execution.assertTool(run, {
    toolCallId: "read_fixture",
    capability: "artifact.read",
    args: {
      relPath: "fixture.txt"
    }
  })).resolves.toBeUndefined();
  await expect(execution.assertTool(run, {
    toolCallId: "write_fixture",
    capability: "artifact.write",
    args: {
      relPath: "fixture.txt",
      content: "changed",
      mimeType: "text/plain"
    }
  })).rejects.toThrow();
  await expect(execution.assertTool(run, {
    toolCallId: "unknown_fixture",
    capability: "agent.task",
    args: {
      prompt: "unknown side effects"
    }
  })).rejects.toThrow();
});
it("persists pause then cancels only this routine's canonical task; resume does not replay it", async () => {
  const {
    createBotRoutineExecution
  } = await import("../../../packages/gateway/src/bots/routine-execution.js");
  const {
      service,
      r,
      f,
      at,
      repo
    } = await activated(),
    input = await admitFixture(f.fireId),
    cancelRun = vi.fn(async () => {
      const active = (await createBotTasksRepository(data.db).get({
        ownerId: OWNER,
        taskId: f.taskId
      }))!;
      await createBotTasksRepository(data.db).transition({
        ownerId: OWNER,
        taskId: f.taskId,
        baseRevision: active.revision,
        to: "cancelled",
        now: at
      });
      await execution.completeRun(input, {
        status: "cancelled"
      });
      return {};
    });
  const execution = createBotRoutineExecution({
    db: data.db,
    approvals: service,
    now: () => new Date(at)
  });
  execution.connect({
    repository: input.repository,
    orchestrator: {
      cancelRun
    } as never
  });
  const task = await createBotTasksRepository(data.db).get({
    ownerId: OWNER,
    taskId: f.taskId
  });
  await createBotTasksRepository(data.db).transition({
    ownerId: OWNER,
    taskId: f.taskId,
    baseRevision: task!.revision,
    to: "running",
    runId: input.runId,
    now: at
  });
  const latest = (await repo.get(OWNER, r.routineId))!,
    paused = await execution.control(OWNER, BOT, r.routineId, {
      baseRevision: latest.revision,
      status: "paused"
    });
  expect(cancelRun).toHaveBeenCalledWith(input.owner, CHAT, input.runId);
  expect(paused.status).toBe("paused");
  await execution.control(OWNER, BOT, r.routineId, {
    baseRevision: paused.revision,
    status: "active"
  });
  expect((await repo.fires(OWNER, r.routineId))[0].status).toBe("cancelled");
});
it("fences a still-live old worker after lease loss and a second scheduler cannot overlap it", async () => {
  const {
    createBotRoutineExecution
  } = await import("../../../packages/gateway/src/bots/routine-execution.js");
  const {
    createBotRoutineScheduler
  } = await import("../../../packages/gateway/src/bots/routine-scheduler.js");
  const {
    service,
    r,
    f,
    at,
    repo
  } = await activated({
    dispatch: false,
    recurring: true
  });
  let clock = at,
    release!: () => void,
    entered!: () => void;
  const held = new Promise<void>(resolve => {
      release = resolve;
    }),
    running = new Promise<void>(resolve => {
      entered = resolve;
    });
  const execution = createBotRoutineExecution({
    db: data.db,
    approvals: service,
    now: () => new Date(clock)
  });
  let effects = 0,
    fenced = false;
  const secondRun = vi.fn(async () => ({
    status: "completed" as const
  }));
  const first = createBotRoutineScheduler({
    repository: {
      ...repo,
      due: async () => [],
      pending: async () => {
        const fire = await repo.getFire(OWNER, f.fireId);
        return fire?.status === "claimed" ? [fire] : [];
      }
    },
    authorize: service.authorize,
    now: () => new Date(clock),
    run: async () => {
      const task = (await createBotTasksRepository(data.db).get({
        ownerId: OWNER,
        taskId: f.taskId
      }))!;
      await createBotTasksRepository(data.db).transition({
        ownerId: OWNER,
        taskId: f.taskId,
        baseRevision: task.revision,
        to: "running",
        runId: "run_old_lease_fixture",
        now: clock
      });
      entered();
      await held;
      try {
        await execution.assertTool({
          ...binding,
          taskId: f.taskId,
          runId: "run_old_lease_fixture",
          requestClass: "background"
        }, {
          toolCallId: "late_effect_fixture",
          capability: "artifact.read",
          args: {
            relPath: "fixture.txt"
          }
        });
        effects++;
      } catch (error: unknown) {
        expect(error).toMatchObject({
          code: "not_granted"
        });
        fenced = true;
      }
      return {
        status: "uncertain"
      };
    }
  });
  const second = createBotRoutineScheduler({
    repository: repo,
    authorize: service.authorize,
    run: secondRun,
    now: () => new Date(clock)
  });
  const active = first.tick();
  await running;
  try {
    clock = new Date(Date.parse(at) + 13 * 60000).toISOString();
    await second.tick();
    expect(secondRun).not.toHaveBeenCalled();
    expect(await repo.fires(OWNER, r.routineId)).toHaveLength(1);
  } finally {
    release();
    await active;
    await first.stop();
    await second.stop();
  }
  expect(effects).toBe(0);
  expect(fenced).toBe(true);
  expect((await repo.getFire(OWNER, f.fireId))?.status).toBe("uncertain");
});
it("publishes the persisted failure and pauses until the person explicitly resumes", async () => {
  const {
    createBotRoutineExecution
  } = await import("../../../packages/gateway/src/bots/routine-execution.js");
  const {
      service,
      r,
      f,
      at,
      repo
    } = await activated(),
    input = await admitFixture(f.fireId),
    execution = createBotRoutineExecution({
      db: data.db,
      approvals: service,
      now: () => new Date(at)
    });
  const task = (await createBotTasksRepository(data.db).get({
    ownerId: OWNER,
    taskId: f.taskId
  }))!;
  await createBotTasksRepository(data.db).transition({
    ownerId: OWNER,
    taskId: f.taskId,
    baseRevision: task.revision,
    to: "running",
    runId: input.runId,
    now: at
  });
  const before = await data.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "bot.authority.changed").execute();
  await execution.completeRun(input, {
    status: "blocked",
    blockedReason: "policy_denied"
  });
  expect((await repo.get(OWNER, r.routineId))?.status).toBe("paused");
  expect((await repo.getFire(OWNER, f.fireId))?.failureCode).toBe("policy_denied");
  const after = await data.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "bot.authority.changed").execute();
  expect(after.length).toBe(before.length + 1);
});
it.each(["archive", "share", "unbind"] as const)("revokes a live background effect when its direct Chat changes: %s", async change => {
  const {
    createBotRoutineExecution
  } = await import("../../../packages/gateway/src/bots/routine-execution.js");
  const {
      service,
      f,
      at
    } = await activated(),
    execution = createBotRoutineExecution({
      db: data.db,
      approvals: service,
      now: () => new Date(at)
    });
  const task = (await createBotTasksRepository(data.db).get({
    ownerId: OWNER,
    taskId: f.taskId
  }))!;
  await createBotTasksRepository(data.db).transition({
    ownerId: OWNER,
    taskId: f.taskId,
    baseRevision: task.revision,
    to: "running",
    runId: "run_live_chat_fixture",
    now: at
  });
  const running = {
    ...binding,
    taskId: f.taskId,
    runId: "run_live_chat_fixture",
    requestClass: "background" as const
  };
  await execution.assertBinding(running);
  if (change === "archive") await data.db.updateTable("chats").set({
    lifecycle: "archived"
  }).where("id", "=", CHAT).execute();else if (change === "share") await sql`UPDATE chats SET collaboration='{}'::jsonb WHERE id=${CHAT}`.execute(data.db);else await data.db.updateTable("bot_chat_bindings").set({
    removed_at: at
  }).where("chat_id", "=", CHAT).execute();
  await expect(execution.assertBinding(running)).rejects.toMatchObject({
    code: "not_granted"
  });
});
it("uses the caller's transaction for the final integration source checkpoint", async () => {
  const {
    createBotRoutineExecution
  } = await import("../../../packages/gateway/src/bots/routine-execution.js");
  const {
    createBotIntegrationTools
  } = await import("../../../packages/gateway/src/bots/integration-tools.js");
  const {
    createBotRecipeCatalog
  } = await import("../../../packages/gateway/src/bots/recipe-catalog.js");
  const {
    createBotGrantsRepository
  } = await import("../../../packages/gateway/src/bots/repositories/grants.js");
  const {
      service,
      f,
      at
    } = await activated(),
    transact = createBotStateTransactions(new ChatRepository(data.db as never));
  const execution = createBotRoutineExecution({
      db: data.db,
      approvals: service,
      transact,
      now: () => new Date(at)
    }),
    task = (await createBotTasksRepository(data.db).get({
      ownerId: OWNER,
      taskId: f.taskId
    }))!;
  await createBotTasksRepository(data.db).transition({
    ownerId: OWNER,
    taskId: f.taskId,
    baseRevision: task.revision,
    to: "running",
    runId: "run_scoped_fixture",
    now: at
  });
  const running = {
    ...binding,
    taskId: f.taskId,
    runId: "run_scoped_fixture",
    requestClass: "background" as const
  };
  await createBotGrantsRepository(data.db).grant({
    ownerId: OWNER,
    botId: BOT,
    service: "gmail",
    connectionId: "conn_fixture",
    accountLabel: "Fixture",
    effects: ["read"],
    audience: "direct",
    grantedByActorId: OWNER,
    now: at
  });
  const call = vi.fn(async () => ({
      data: {
        fixture: true
      }
    })),
    guard = vi.fn(async (run: BotRuntimeBinding, _signal?: AbortSignal, executor?: import("../../../packages/gateway/src/bots/repositories/shared.js").BotExecutor) => {
      await execution.assertBinding(run, executor);
    });
  const tools = createBotIntegrationTools({
    transact,
    client: {
      inventory: async () => [{
        connectionId: "conn_fixture",
        service: "gmail",
        label: "Fixture"
      }],
      call,
      describe: async () => [],
      connect: async () => {
        throw new Error("unused");
      },
      sync: async () => {
        throw new Error("unused");
      },
      callImportRead: async () => {
        throw new Error("unused");
      },
      callAppAction: async () => {
        throw new Error("unused");
      }
    },
    assertSource: guard,
    now: () => new Date(at),
    agents: {
      get: async () => ({
        id: BOT,
        recipeRef: {
          recipeId: "fixture",
          version: "1"
        }
      }) as never
    },
    recipes: createBotRecipeCatalog([{
      recipeId: "fixture",
      version: "1",
      name: "Fixture",
      description: "Fixture",
      instructions: "Fixture",
      capabilities: ["integration.call"],
      integrations: [{
        service: "gmail",
        effects: ["read"],
        required: true
      }],
      output: "Fixture"
    }])
  });
  await expect(tools.call(running, {
    service: "gmail",
    action: "list_threads",
    connectionId: "conn_fixture",
    params: {}
  })).resolves.toMatchObject({
    ok: true
  });
  expect(call).toHaveBeenCalledTimes(1);
  expect(guard.mock.calls.some(args => args[2]?.isTransaction)).toBe(true);
});
it("does not treat a canonical cancellation projection as proof that the old worker exited", async () => {
  const {
    createBotRoutineExecution
  } = await import("../../../packages/gateway/src/bots/routine-execution.js");
  const {
      service,
      r,
      f,
      at,
      repo
    } = await activated(),
    input = await admitFixture(f.fireId);
  const execution = createBotRoutineExecution({
    db: data.db,
    approvals: service,
    now: () => new Date(at)
  });
  execution.connect({
    repository: input.repository,
    orchestrator: {
      cancelRun: async () => ({
        cancellation: "aborted"
      })
    } as never
  });
  const task = (await createBotTasksRepository(data.db).get({
    ownerId: OWNER,
    taskId: f.taskId
  }))!;
  await createBotTasksRepository(data.db).transition({
    ownerId: OWNER,
    taskId: f.taskId,
    baseRevision: task.revision,
    to: "running",
    runId: input.runId,
    now: at
  });
  const latest = (await repo.get(OWNER, r.routineId))!,
    paused = await execution.control(OWNER, BOT, r.routineId, {
      baseRevision: latest.revision,
      status: "paused"
    });
  expect((await repo.getFire(OWNER, f.fireId))?.status).toBe("uncertain");
  await expect(execution.control(OWNER, BOT, r.routineId, {
    baseRevision: paused.revision,
    status: "active"
  })).rejects.toMatchObject({
    code: "conflict"
  });
  expect((await execution.list(OWNER, BOT))[0]).toMatchObject({
    requiresReview: true,
    status: "paused"
  });
});
it("retries only proven pre-worker capacity, with a bounded durable fire and exact attempt fencing", async () => {
  const {
    createBotRoutineExecution
  } = await import("../../../packages/gateway/src/bots/routine-execution.js");
  const {
      service,
      r,
      f,
      at,
      repo
    } = await activated(),
    input = await admitFixture(f.fireId);
  let clock = at;
  const execution = createBotRoutineExecution({
      db: data.db,
      approvals: service,
      now: () => new Date(clock)
    }),
    tasks = createBotTasksRepository(data.db);
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      clock = new Date(Date.parse(clock) + 60_000).toISOString();
      await repo.dispatch({
        ownerId: OWNER,
        fireId: f.fireId,
        now: clock
      });
      await data.db.updateTable("chat_runs").set({
        client_request_id: `req_routine_${f.fireId}_a${attempt}`
      }).where("id", "=", input.runId).execute();
    }
    expect((await execution.prepareRun(input))?.backgroundTaskId).toBe(f.taskId);
    const task = (await tasks.get({
      ownerId: OWNER,
      taskId: f.taskId
    }))!;
    await tasks.transition({
      ownerId: OWNER,
      taskId: f.taskId,
      baseRevision: task.revision,
      to: "running",
      runId: input.runId,
      now: clock
    });
    const running = (await tasks.get({
      ownerId: OWNER,
      taskId: f.taskId
    }))!;
    await tasks.transition({
      ownerId: OWNER,
      taskId: f.taskId,
      baseRevision: running.revision,
      to: "blocked",
      blockedReason: "capacity_unavailable",
      now: clock
    });
    await execution.completeRun(input, {
      status: "blocked",
      blockedReason: "capacity_unavailable",
      retryableBeforeDispatch: true
    });
    const fire = (await repo.getFire(OWNER, f.fireId))!;
    expect(fire).toMatchObject({
      attempts: attempt,
      status: attempt < 3 ? "claimed" : "failed",
      failureCode: attempt < 3 ? "capacity_unavailable" : "capacity_exhausted"
    });
    expect((await repo.get(OWNER, r.routineId))?.status).toBe(attempt < 3 ? "active" : "paused");
    if (attempt < 3) expect(Date.parse(fire.retryAfter!)).toBe(Date.parse(clock) + 30_000 * attempt);
  }
  expect(await data.db.selectFrom("bot_tasks").select("task_id").where("task_id", "=", f.taskId).execute()).toHaveLength(1);
});
it("never retries a worker's capacity outcome without pre-dispatch proof", async () => {
  const {
    createBotRoutineExecution
  } = await import("../../../packages/gateway/src/bots/routine-execution.js");
  const {
      service,
      f,
      at,
      repo
    } = await activated(),
    input = await admitFixture(f.fireId),
    tasks = createBotTasksRepository(data.db);
  const task = (await tasks.get({
    ownerId: OWNER,
    taskId: f.taskId
  }))!;
  await tasks.transition({
    ownerId: OWNER,
    taskId: f.taskId,
    baseRevision: task.revision,
    to: "running",
    runId: input.runId,
    now: at
  });
  await createBotRoutineExecution({
    db: data.db,
    approvals: service,
    now: () => new Date(at)
  }).completeRun(input, {
    status: "waiting_capacity",
    blockedReason: "capacity_unavailable"
  });
  expect((await repo.getFire(OWNER, f.fireId))?.status).toBe("failed");
});
it.each([["write", "dispatched", "completed"], ["send", "effect_unknown", "completed"], ["write", "effect_unknown", "cancelled"]] as const)("holds an %s checkpoint in %s despite worker %s", async (effectClass, phase, status) => {
  const {
      createBotRoutineExecution
    } = await import("../../../packages/gateway/src/bots/routine-execution.js"),
    {
      createBotCheckpointsRepository
    } = await import("../../../packages/gateway/src/bots/repositories/checkpoints.js");
  const {
      service,
      r,
      f,
      at,
      repo
    } = await activated({
      recurring: true
    }),
    input = await admitFixture(f.fireId),
    tasks = createBotTasksRepository(data.db),
    task = (await tasks.get({
      ownerId: OWNER,
      taskId: f.taskId
    }))!;
  await tasks.transition({
    ownerId: OWNER,
    taskId: f.taskId,
    baseRevision: task.revision,
    to: "running",
    runId: input.runId,
    now: at
  });
  const checkpoints = createBotCheckpointsRepository(data.db),
    {
      checkpoint
    } = await checkpoints.prepare({
      ownerId: OWNER,
      taskId: f.taskId,
      runId: input.runId,
      toolCallId: "call_unknown_fixture",
      action: {
        capability: "integration.call"
      },
      effectClass,
      now: at
    });
  await checkpoints.markDispatched({
    ownerId: OWNER,
    checkpointId: checkpoint.checkpointId,
    now: at
  });
  if (phase === "effect_unknown") await checkpoints.markEffectUnknown({
    ownerId: OWNER,
    checkpointId: checkpoint.checkpointId,
    now: at
  });
  const execution = createBotRoutineExecution({
    db: data.db,
    approvals: service,
    now: () => new Date(at)
  });
  expect(await execution.completeRun(input, {
    status
  })).toMatchObject({
    status: "uncertain"
  });
  expect((await repo.getFire(OWNER, f.fireId))?.status).toBe("uncertain");
  expect((await execution.list(OWNER, BOT))[0].requiresReview).toBe(true);
  expect((await repo.due(new Date(Date.parse(at) + 60000).toISOString())).some(row => row.routineId === r.routineId)).toBe(false);
});
it.each(["invalid_claim", "expired_dispatch"] as const)("publishes recovery %s once with its durable transition", async kind => {
  const {
      createBotRoutineExecution
    } = await import("../../../packages/gateway/src/bots/routine-execution.js"),
    {
      service,
      f,
      at
    } = await activated({
      dispatch: kind === "expired_dispatch"
    });
  if (kind === "invalid_claim") await data.db.updateTable("chats").set({
    lifecycle: "archived"
  }).where("id", "=", CHAT).execute();
  const count = async () => Number((await data.db.selectFrom("chat_outbox").select(eb => eb.fn.countAll<number>().as("n")).where("event_type", "in", ["bot.authority.changed", "bot.task.updated"]).executeTakeFirstOrThrow()).n),
    before = await count();
  for (let restart = 0; restart < 2; restart++) {
    const execution = createBotRoutineExecution({
      db: data.db,
      approvals: service,
      now: () => new Date(Date.parse(at) + 15 * 60000)
    });
    try {
      await execution.start({
        repository: new ChatRepository(data.db as never),
        orchestrator: {}
      } as never);
    } finally {
      await execution.stop();
    }
    expect(await count()).toBe(before + 2);
  }
  expect((await createBotRoutinesRepository(data.db).getFire(OWNER, f.fireId))?.status).toBe(kind === "invalid_claim" ? "failed" : "uncertain");
});
it("cancels a proven capacity wait without cancelling its terminal previous run", async () => {
  const {
      createBotRoutineExecution
    } = await import("../../../packages/gateway/src/bots/routine-execution.js"),
    {
      service,
      r,
      f,
      at,
      repo
    } = await activated(),
    tasks = createBotTasksRepository(data.db),
    task = (await tasks.get({
      ownerId: OWNER,
      taskId: f.taskId
    }))!;
  await tasks.transition({
    ownerId: OWNER,
    taskId: f.taskId,
    baseRevision: task.revision,
    to: "running",
    runId: "run_old_capacity_wait",
    now: at
  });
  await tasks.transition({
    ownerId: OWNER,
    taskId: f.taskId,
    baseRevision: task.revision + 1,
    to: "blocked",
    blockedReason: "capacity_unavailable",
    now: at
  });
  await repo.defer({
    ownerId: OWNER,
    fireId: f.fireId,
    retryAfter: new Date(Date.parse(at) + 30000).toISOString(),
    now: at
  });
  const cancelRun = vi.fn(async () => {
      throw new Error("old terminal run must not be cancelled");
    }),
    execution = createBotRoutineExecution({
      db: data.db,
      approvals: service,
      now: () => new Date(at)
    });
  execution.connect({
    repository: new ChatRepository(data.db as never),
    orchestrator: {
      cancelRun
    }
  } as never);
  await execution.control(OWNER, BOT, r.routineId, {
    baseRevision: (await repo.get(OWNER, r.routineId))!.revision,
    status: "paused"
  });
  expect(cancelRun).not.toHaveBeenCalled();
  expect((await repo.getFire(OWNER, f.fireId))?.status).toBe("cancelled");
});
it.each(["completed", "failed"] as const)("preserves recovered uncertain status over a late worker %s result", async status => {
  const {
      createBotRoutineExecution
    } = await import("../../../packages/gateway/src/bots/routine-execution.js"),
    {
      service,
      f,
      at,
      repo
    } = await activated(),
    input = await admitFixture(f.fireId),
    tasks = createBotTasksRepository(data.db),
    task = (await tasks.get({
      ownerId: OWNER,
      taskId: f.taskId
    }))!;
  await tasks.transition({
    ownerId: OWNER,
    taskId: f.taskId,
    baseRevision: task.revision,
    to: "running",
    runId: input.runId,
    now: at
  });
  await repo.recover({
    before: new Date(Date.parse(at) + 15 * 60000).toISOString(),
    now: new Date(Date.parse(at) + 15 * 60000).toISOString()
  });
  const execution = createBotRoutineExecution({
    db: data.db,
    approvals: service,
    now: () => new Date(at)
  });
  expect(await execution.completeRun(input, {
    status
  })).toEqual({
    status: "uncertain"
  });
  expect((await repo.getFire(OWNER, f.fireId))?.status).toBe("uncertain");
});
