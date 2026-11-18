import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { openMatrixSchedule, sealMatrixSchedule, setMatrixScheduleSealKey } from "../../../scripts/openmausbot/matrix-schedule.js";
// @ts-expect-error Build-only patch applied to pinned upstream source.
import { patchMatrixProviderDispatch, patchMatrixProviderRegistry } from "../../../scripts/openmausbot/apply-private-host.mjs";

it("limits provider dispatch to the upstream paired direct-message branch with exact turn identity", () => {
  const source = [
    "import { z } from \"zod\";",
    "        const receipt = await acceptDirectSend({",
    "          botId: bot.id, threadId, text, sendId, replyTo, sender, trigger, dataContext, ...(app ? { app } : {}),",
    "          personPresent, ...(followUp ? { followUp } : {}),",
    "          ...(mentions?.length && !press && !appSent ? { mentions } : {}),",
    "        }, guardedStart);",
  ].join("\n");
  const route = patchMatrixProviderDispatch(source);
  expect(route).toContain('auth.kind === "session"');
  expect(route).toContain('if (!guarded && !press && !appSent && !pointed && !pageOpen && !followUp');
  expect(route).toContain('{ botId: bot.id, threadId, sendId }');
  expect(() => patchMatrixProviderDispatch(source.replace("acceptDirectSend", "changedUpstream"))).toThrow(/pinned source/);
});

it("registers the served Matrix model as an actual upstream provider only in the private workload", async () => {
  const source = [
    'import { basename, join } from "node:path";',
    "const providerConfigs = () => hostedModels ? hostedModels.configs() : instanceConfigs(cfg);",
    'const registry = new ProviderRegistry(BUILT_IN_DRIVERS, { statusFile: join(DATA_DIR, "providers", "engine-status.json") });',
    "  const message = await startTurn(botId, text, { threadId, replyTo, sendId, sender, trigger, via, callId, dataContext, app, mentions, allowRoomTurnElsewhere: true });",
    "    requestMessageId?: string;",
    "    origin?: WorkOrigin;",
    "savedSteps.dispatch.sendTurn(instance, personLine &&",
    "(input) => quickFallback.sendTurn(instance, input, route.quickModel ? { model, own: bot.modelSelection, onFallback: () => store.patchMessage(threadId, userMessage.id, { quickModel: undefined }) } : undefined)",
    "    if (hostedModels) return { ...described, readOnly: true,",
  ].join("\n");
  const registry = patchMatrixProviderRegistry(source);
  expect(registry).toContain('process.env.OMB_MATRIX_PAIR_SOCKET');
  expect(registry).toContain('[...BUILT_IN_DRIVERS, matrixHostedDriver]');
  expect(registry).toContain('matrixHostedTurn: takeMatrixHostedOwnerSend(botId, threadId, sendId)');
  expect(registry).toContain('runMatrixHostedModelTurn(instance.instanceId, opts?.matrixHostedTurn, activeMessages, skipTranscript,');
  expect(registry).toContain('instance.instanceId !== MATRIX_HOSTED_INSTANCE && personLine');
  const provider = await readFile("scripts/openmausbot/matrix-provider.ts", "utf8");
  expect(provider).toContain('type: "item.completed", itemType: "assistant_text"');
  expect(provider).toContain('type: "turn.completed"');
  expect(provider).not.toContain("generateText");
});

it("seals a routine's broker capability across daemon restart and denies copied or modified seals", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const token = "aa".repeat(32);
  setMatrixScheduleSealKey(Buffer.alloc(64, "b"));
  expect(sealMatrixSchedule("malformed")).toBeUndefined();
  const record = sealMatrixSchedule(id + ":" + token)!;
  expect(record).toEqual({ routineId: id, sealedGrant: expect.stringMatching(/^[A-Za-z0-9_-]{80}$/) });
  expect(record.sealedGrant).not.toContain(token);
  expect(openMatrixSchedule(id, record.sealedGrant)).toBe(token);
  expect(openMatrixSchedule("550e8400-e29b-41d4-a716-446655440001", record.sealedGrant)).toBeUndefined();
  const first = record.sealedGrant[0] === "a" ? "b" : "a";
  expect(openMatrixSchedule(id, first + record.sealedGrant.slice(1))).toBeUndefined();
  setMatrixScheduleSealKey(Buffer.alloc(64, "c"));
  expect(openMatrixSchedule(id, record.sealedGrant)).toBeUndefined();
  setMatrixScheduleSealKey(Buffer.alloc(64, "b"));
  expect(openMatrixSchedule(id, record.sealedGrant)).toBe(token);
});

it("gives the private scheduled turn a separate bounded authority and inference window", async () => {
  const provider = await readFile("scripts/openmausbot/matrix-provider.ts", "utf8");
  expect(provider).toContain("const SCHEDULED_TURN_TIMEOUT = 45_000;");
  expect(provider).toContain("const timeout = schedule ? SCHEDULED_TURN_TIMEOUT : catalog?.turnTimeouts.get(selected) ?? TEXT_TURN_TIMEOUT;");
});
