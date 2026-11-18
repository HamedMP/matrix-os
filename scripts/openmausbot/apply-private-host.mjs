import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pairingListener = `
// Matrix Computer commissioning stays on a separate Unix socket whose
// parent directory is private to this daemon. Its normal HTTP socket still
// uses upstream's remote authentication and one-time pairing exchange.
const matrixPairSocket = process.env.OMB_MATRIX_PAIR_SOCKET;
let matrixPairingListener: ReturnType<typeof createServer> | null = null;
if (matrixPairSocket) {
  const pairSocket = matrixPairSocket;
  if (!TUNNEL_SOCKET || dirname(dirname(pairSocket)) !== dirname(TUNNEL_SOCKET)) {
    throw new Error("Invalid Matrix pairing socket configuration");
  }
  mkdirSync(dirname(pairSocket), { mode: 0o700, recursive: true });
  chmodSync(dirname(pairSocket), 0o700);
  rmSync(pairSocket, { force: true });
  // Like the upstream CLI owner proof, this comes from stdin and is never
  // inherited by Bot processes in the environment or written in their volume.
  let proof = "";
  let expectedProof: Buffer | undefined;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    proof += chunk;
    if (proof.length <= 65 && !proof.includes("\\n")) return;
    if (/^[a-f0-9]{64}\\n$/.test(proof)) {
      expectedProof = Buffer.from(proof.trim());
      setMatrixScheduleSealKey(expectedProof);
    }
    proof = "";
    process.stdin.destroy();
  });
  let outstandingPairing: string | undefined;
  matrixPairingListener = createServer({ headersTimeout: 5_000, requestTimeout: 5_000 }, (req, res) => {
    if (req.method !== "POST" || req.url !== "/pairing") return json(res, 404, { error: "Not found" });
    const presented = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "");
    if (!expectedProof || !presented || !matrixTimingSafeEqual(expectedProof, Buffer.from(presented[1]!))) {
      return json(res, 403, { error: "Forbidden" });
    }
    if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] ?? 0) !== 0) {
      return json(res, 400, { error: "A body is not accepted" });
    }
    if (outstandingPairing) sessions.cancelPairing(outstandingPairing);
    const opened = sessions.openPairing({ label: "Matrix Computer", ttlMs: 5 * 60_000 });
    outstandingPairing = opened.id;
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { code: formatPairingCode(opened.code), expiresAt: opened.expiresAt });
  });
  matrixPairingListener.listen(pairSocket, () => chmodSync(pairSocket, 0o600));
}
`;

function replacePinned(source, match, replacement) {
  const first = source.indexOf(match);
  if (first < 0 || source.indexOf(match, first + match.length) >= 0) {
    throw new Error(`Expected one pinned source anchor: ${match}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + match.length);
}

export function patchPrivateHost(source) {
  let patched = replacePinned(source, 'import { existsSync, realpathSync, rmSync } from "node:fs";',
    'import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";\nimport { timingSafeEqual as matrixTimingSafeEqual } from "node:crypto";');
  patched = replacePinned(patched, 'import { basename, join } from "node:path";',
    'import { basename, dirname, join } from "node:path";');
  patched = replacePinned(patched, 'if (HOSTED_WORKSPACE) setDefaultApprovalMode("ask");',
    'if (HOSTED_WORKSPACE || process.env.OMB_MATRIX_PAIR_SOCKET) setDefaultApprovalMode("ask");');
  const customMcpAnchor = '        const custom = await mcpServersHost.prepare(bot).then(() => teamConnections.turnMcp(bot, threadId, dispatchClaimId));';
  patched = replacePinned(patched, customMcpAnchor, `${customMcpAnchor}
        // Mount for direct paired-user turns only. The Matrix broker still
        // requires a fresh owner decision for every read, even if called directly.
        if (process.env.OMB_MATRIX_DRIVE_MCP === "1" && personLine && !opts?.unattended
          && !opts?.app && !userMessage.relayed && opts?.trigger?.kind === "user") {
          custom["matrix-drive-preview"] = {
            command: "/usr/local/bin/node", args: ["/opt/openmausbot/matrix-drive-mcp.mjs"], env: {},
          };
        }`);
  const tunnelAnchor = [
    '    console.log(`openmausbot tunnel listener on ${TUNNEL_SOCKET}`);',
    '  });',
    '}',
  ].join("\n");
  patched = replacePinned(patched, tunnelAnchor, tunnelAnchor + "\n" + pairingListener);
  return replacePinned(patched, "      tunnelListener?.close(); stopCloudHomeConnectedApps();",
    "      tunnelListener?.close(); matrixPairingListener?.close(); stopCloudHomeConnectedApps();");
}

export function patchMatrixProviderRegistry(source) {
  let patched = replacePinned(source, 'import { basename, join } from "node:path";',
    'import { basename, join } from "node:path";\nimport { MATRIX_HOSTED_INSTANCE, matrixHostedDriver, matrixHostedProviderConfigs, runMatrixHostedModelTurn, takeMatrixHostedOwnerSend, type MatrixHostedTurnTicket } from "./drivers/matrix-provider.ts";');
  patched = replacePinned(patched, "const providerConfigs = () => hostedModels ? hostedModels.configs() : instanceConfigs(cfg);",
    "const providerConfigs = () => matrixHostedProviderConfigs(hostedModels ? hostedModels.configs() : instanceConfigs(cfg));");
  patched = replacePinned(patched, 'const registry = new ProviderRegistry(BUILT_IN_DRIVERS, { statusFile:',
    'const registry = new ProviderRegistry(process.env.OMB_MATRIX_PAIR_SOCKET ? [...BUILT_IN_DRIVERS, matrixHostedDriver] : BUILT_IN_DRIVERS, { statusFile:');
  const direct = "  const message = await startTurn(botId, text, { threadId, replyTo, sendId, sender, trigger, via, callId, dataContext, app, mentions, allowRoomTurnElsewhere: true });";
  patched = replacePinned(patched, direct, direct.replace("allowRoomTurnElsewhere: true", "allowRoomTurnElsewhere: true, matrixHostedTurn: takeMatrixHostedOwnerSend(botId, threadId, sendId)"));
  patched = replacePinned(patched, "    requestMessageId?: string;\n    origin?: WorkOrigin;", "    requestMessageId?: string;\n    matrixHostedTurn?: MatrixHostedTurnTicket;\n    origin?: WorkOrigin;");
  const replayCondition = "savedSteps.dispatch.sendTurn(instance, personLine &&";
  patched = replacePinned(patched, replayCondition, "savedSteps.dispatch.sendTurn(instance, instance.instanceId !== MATRIX_HOSTED_INSTANCE && personLine &&");
  const turnDispatch = '(input) => quickFallback.sendTurn(instance, input, route.quickModel ? { model, own: bot.modelSelection, onFallback: () => store.patchMessage(threadId, userMessage.id, { quickModel: undefined }) } : undefined)';
  patched = replacePinned(patched, turnDispatch,
    '(input) => runMatrixHostedModelTurn(instance.instanceId, opts?.matrixHostedTurn, activeMessages, skipTranscript, () => ' + turnDispatch.slice('(input) => '.length) + ')');
  const readOnly = '    if (hostedModels) return { ...described, readOnly: true,';
  return replacePinned(patched, readOnly, readOnly.replace('hostedModels', 'hostedModels || instance.instanceId === MATRIX_HOSTED_INSTANCE'));
}

export function patchMatrixProviderDispatch(source) {
  let patched = replacePinned(source, 'import { z } from "zod";',
    'import { z } from "zod";\nimport { withMatrixHostedOwnerSend } from "../drivers/matrix-provider.ts";');
  patched = replacePinned(patched, "        const receipt = await acceptDirectSend({", "        const dispatch = () => acceptDirectSend({");
  return replacePinned(patched, "        }, guardedStart);", `        }, guardedStart);
        let receipt: DirectSendReceipt;
        if (!guarded && !press && !appSent && !pointed && !pageOpen && !followUp && auth.kind === "session" && sendId) {
          receipt = await withMatrixHostedOwnerSend(req.headers["x-matrix-hosted-bots-model-turn"], { botId: bot.id, threadId, sendId }, dispatch);
        } else {
          receipt = await dispatch();
        }`);
}


export function patchMatrixScheduleIndex(source) {
  let patched = replacePinned(source, 'import { basename, join } from "node:path";',
    'import { basename, join } from "node:path";\nimport { openMatrixSchedule, sealMatrixSchedule, setMatrixScheduleSealKey } from "./drivers/matrix-schedule.ts";');
  const sourceAnchor = 'function routineSourceThread(run: RoutineRun): string | null {';
  patched = replacePinned(patched, sourceAnchor, `// Matrix's owner-confirmed routine is joined only to the exact existing direct conversation.
function matrixHostedScheduleSource(botId: string, threadId: unknown) {
  if (typeof threadId !== "string" || cloudGuestOpened(threadId) || store.groupByThread(threadId)) return null;
  const profile = store.bot(botId);
  const task = store.taskByThread(botId, threadId);
  if (!profile || profile.hidden || !task || task.archivedAt || task.routineRunId) return null;
  return store.projectBotForTask(botId, threadId);
}

function matrixHostedScheduleRun(run: RoutineRun) {
  if (!routines?.hostedScheduleGrant(run.routineId)) return null;
  const routine = routines.listRoutines().find(candidate => candidate.id === run.routineId);
  const model = routine?.modelSelection;
  const current = matrixHostedScheduleSource(run.botId, run.resultsThreadId)?.modelSelection;
  const valid = run.target === "bot" && !run.manual && run.triggerSource === "schedule" && !run.retried && !run.eventSource
    && run.runOn === "maus" && !run.attachments?.length && !run.access && !run.deliver
    && routine?.botId === run.botId && routine.schedule.type === "once" && routine.schedule.at === run.scheduledFor
    && typeof run.resultsThreadId === "string" && run.resultsThreadId === routine.resultsThreadId
    && model?.instanceId === MATRIX_HOSTED_INSTANCE
    && current?.instanceId === model.instanceId && current.model === model.model;
  if (!valid || !model || !run.resultsThreadId) return false;
  return { threadId: run.resultsThreadId, schedule: { routineId: run.routineId, scheduledFor: run.scheduledFor, modelId: model.model } };
}

${sourceAnchor}`);
  const joins = '  joinConversation: (run) => {\n    if (run.eventSource === "wait")';
  patched = replacePinned(patched, joins, '  joinHostedSchedule: (run) => {\n    const matrix = matrixHostedScheduleRun(run);\n    return matrix ? matrix.threadId : matrix;\n  },\n' + joins);
  const turn = '  startTurn: async (botId, threadId, prompt, runOn, triggerSource, onDispatchError) => {\n    if (!companyShutdown) await startTurn(botId, prompt, { threadId, runOn, automationSource: triggerSource, onDispatchError });\n  },';
  patched = replacePinned(patched, turn, `  startTurn: async (botId, threadId, prompt, runOn, triggerSource, onDispatchError, run) => {
    if (companyShutdown) return;
    const matrix = matrixHostedScheduleRun(run);
    if (matrix !== null) {
      const grant = routines?.hostedScheduleGrant(run.routineId);
      const token = matrix && grant ? openMatrixSchedule(run.routineId, grant) : undefined;
      if (!matrix || matrix.threadId !== threadId || !token) {
        onDispatchError("This scheduled Matrix model or conversation is no longer available.");
        return;
      }
      await startTurn(botId, prompt, {
        threadId, runOn: "maus", automationSource: triggerSource, onDispatchError, unattended: true,
        matrixHostedTurn: { botId, threadId, sendId: run.id, token, schedule: matrix.schedule },
      });
      return;
    }
    await startTurn(botId, prompt, { threadId, runOn, automationSource: triggerSource, onDispatchError });
  },`);
  const create = '      const routine = withRoutineWriter(writer, () => routines!.create(body));';
  patched = replacePinned(patched, create, `      let hostedGrant: ReturnType<typeof sealMatrixSchedule>;
      if (process.env.OMB_MATRIX_PAIR_SOCKET && body && typeof body === "object" && typeof body.botId === "string") {
        const source = matrixHostedScheduleSource(body.botId, body.resultsThreadId);
        const selected = body.modelSelection?.instanceId ?? (source ?? store.bot(body.botId))?.modelSelection.instanceId;
        if (selected === MATRIX_HOSTED_INSTANCE) {
          if (auth.kind !== "session" || !ownerOrAdmin(auth)) return json(res, 403, { error: "Only the paired Matrix owner can schedule this model." });
          hostedGrant = sealMatrixSchedule(req.headers["x-matrix-hosted-bots-schedule"]);
          const model = body.modelSelection;
          if (!hostedGrant || !source || model?.instanceId !== MATRIX_HOSTED_INSTANCE || model.model !== source.modelSelection.model
            || model.instanceId !== source.modelSelection.instanceId || body.schedule?.type !== "once") {
            return json(res, 409, { error: "Save a one-time automation with an existing conversation on this bot and its current Matrix model." });
          }
        }
      }
      const routine = withRoutineWriter(writer, () => routines!.create(body, undefined, hostedGrant));`);
  patched = replacePinned(patched, '      const run = routines!.runNow(routineMatch[1]);', `      if (routines!.hostedScheduleGrant(routineMatch[1])) return json(res, 409, { error: "This Matrix automation runs once at the scheduled time." });
      const run = routines!.runNow(routineMatch[1]);`);
  const editing = '      const refused = routineBodyRefusal(body, routines!.listRoutines().find((candidate) => candidate.id === routineMatch![1])); if (refused) return json(res, refused.status, { error: refused.error });';
  patched = replacePinned(patched, editing, `      if (routines!.hostedScheduleGrant(routineMatch[1])) {
        if (auth.kind !== "session" || !ownerOrAdmin(auth)) return json(res, 403, { error: "Only the paired Matrix owner can change this automation." });
        if (!body || typeof body !== "object" || body.enabled !== false || Object.keys(body).length !== 1) {
          return json(res, 409, { error: "Pause or delete this Matrix automation and save a new one to change its time, model, or instructions." });
        }
      } else if (process.env.OMB_MATRIX_PAIR_SOCKET && body?.modelSelection?.instanceId === MATRIX_HOSTED_INSTANCE) {
        return json(res, 409, { error: "Save a new one-time automation to use a Matrix model." });
      }
${editing}`);
  const removing = '      const removed = routines!.remove(routineMatch[1]);';
  return replacePinned(patched, removing, `      if (routines!.hostedScheduleGrant(routineMatch[1]) && (auth.kind !== "session" || !ownerOrAdmin(auth))) {
        return json(res, 403, { error: "Only the paired Matrix owner can remove this automation." });
      }
${removing}`);
}

export function patchMatrixScheduleRoutines(source) {
  let patched = replacePinned(source, '  installedPackage?: RoutinePackageStamp;', '  installedPackage?: RoutinePackageStamp;\n  matrixScheduledGrant?: string;');
  patched = replacePinned(patched, '  routineId: string;\n  routineName: string;', '  routineId: string;\n  routineName: string;\n  matrixHostedJoined?: true;');
  patched = replacePinned(patched, '      this.runs.findLast((candidate) => candidate.threadId === threadId);',
    '      this.runs.findLast((candidate) => candidate.threadId === threadId && !candidate.matrixHostedJoined);');
  patched = replacePinned(patched, 'joinConversation?: (run: RoutineRun) => string | null;', 'joinConversation?: (run: RoutineRun) => string | null;\n  joinHostedSchedule?: (run: RoutineRun) => string | null | false;');
  patched = replacePinned(patched, '    onDispatchError: (message: string) => void,\n  ) => Promise<void>;\n  startGoal?: (', '    onDispatchError: (message: string) => void,\n    run: RoutineRun,\n  ) => Promise<void>;\n  startGoal?: (');
  patched = replacePinned(patched, 'const { installedPackage: _installedPackage, ...visible }', 'const { installedPackage: _installedPackage, matrixScheduledGrant: _matrixScheduledGrant, ...visible }');
  patched = replacePinned(patched, '  create(input: RoutineInput, request?: RoutineRequestCommitFor<"create">): Routine {', `  hostedScheduleGrant(id: string): string | undefined {
    return this.routines.find((routine) => routine.id === id)?.matrixScheduledGrant;
  }

  create(input: RoutineInput, request?: RoutineRequestCommitFor<"create">, hostedGrant?: { routineId: string; sealedGrant: string }): Routine {`);
  const create = '      id: randomUUID(),\n      ...clean,\n      // Only a confirmed chat card';
  patched = replacePinned(patched, create, '      id: hostedGrant?.routineId ?? randomUUID(),\n      ...clean,\n      ...(hostedGrant ? { matrixScheduledGrant: hostedGrant.sealedGrant } : {}),\n      // Only a confirmed chat card');
  const join = '        const joined = run.threadId || (run.target === "room-goal" ? null : this.options.joinConversation?.(run)) || null;';
  patched = replacePinned(patched, join, `        const matrixJoined = this.options.joinHostedSchedule?.(run);
        if (matrixJoined === false || (matrixJoined && run.threadId && run.threadId !== matrixJoined)) {
          this.failRun(run, "This scheduled conversation or model is no longer available.");
          continue;
        }
        if (matrixJoined) run.matrixHostedJoined = true;
        const joined = matrixJoined || run.threadId || (run.target === "room-goal" ? null : this.options.joinConversation?.(run)) || null;`);
  const start = '              triggerSource,\n              (message) => this.failThread(task.threadId, message, { cause: "refused" }),';
  return replacePinned(patched, start, start + '\n              cloneRun(run),');
}

export function patchMatrixScheduleCalendar(source) {
  const calendar = 'export function QuickComposer({';
  let patched = replacePinned(source, calendar, `// A Matrix one-shot sends the current source's model and actual thread in
// the existing Save action. Never send a placeholder destination.
function matrixHostedScheduleFields(bot: Bot | undefined, destination: string | null | undefined) {
  if (!bot) return {};
  const resultsThreadId = destination ?? bot.mainThreadId ?? bot.threadId;
  const task = bot.tasks?.find((candidate) => candidate.threadId === resultsThreadId);
  const selection = task?.modelSelection ?? bot.modelSelection;
  if (selection.instanceId !== "matrix-hosted-ai") return {};
  return { resultsThreadId, modelSelection: { instanceId: selection.instanceId, model: selection.model } };
}

${calendar}`);
  patched = replacePinned(patched, '          ...(routineTarget === "bot" ? { resultsThreadId } : {}),',
    '          ...(routineTarget === "bot" ? { resultsThreadId } : {}),\n          ...(!existingRoutine && routineTarget === "bot" ? matrixHostedScheduleFields(selectedBots[0], resultsThreadId) : {}),');
  return replacePinned(patched, '            resultsThreadId,\n          } satisfies RoutineInput),',
    '            resultsThreadId,\n            ...matrixHostedScheduleFields(bots.find((bot) => bot.id === botIds[0]), resultsThreadId),\n          } satisfies RoutineInput),');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error("Usage: apply-private-host.mjs <upstream source directory>");
  const file = resolve(process.argv[2], "server/index.ts");
  const route = resolve(process.argv[2], "server/routes/bot-messages.ts");
  await writeFile(file, patchPrivateHost(patchMatrixScheduleIndex(patchMatrixProviderRegistry(await readFile(file, "utf8")))));
  const routines = resolve(process.argv[2], "server/routines.ts");
  await writeFile(routines, patchMatrixScheduleRoutines(await readFile(routines, "utf8")));
  const calendar = resolve(process.argv[2], "src/components/RoutineCalendarPage.tsx");
  await writeFile(calendar, patchMatrixScheduleCalendar(await readFile(calendar, "utf8")));
  await copyFile(new URL("./matrix-schedule.ts", import.meta.url), resolve(process.argv[2], "server/drivers/matrix-schedule.ts"));
  await writeFile(route, patchMatrixProviderDispatch(await readFile(route, "utf8")));
  await copyFile(new URL("./matrix-provider.ts", import.meta.url), resolve(process.argv[2], "server/drivers/matrix-provider.ts"));
}
