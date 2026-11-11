import { isDeepStrictEqual } from "node:util";
import type { ClaudeNativeSessionPool } from "./claude-native-session.js";
import type { NativeScheduledPhaseRequest } from "./native-scheduled-admission.js";
import { resolveClaudeSessionSource } from "./claude-session-source.js";
import { ClaudeNativeProbeCleanupError, disallowNativeCronCreate, resolveClaudeNativeProtocol } from "./claude-native-protocol.js";
import { createClaudeRoutineHook } from "./claude-routine-hook.js";
import { createClaudeRoutineExecution, type NativeRoutineCliPort } from "./claude-routine-execution.js";
import type { SharedBrowserBroker } from "../shared-browser/broker.js";
import { openNativeSharedBrowserRun, type NativeSharedBrowserRun } from "./native-shared-browser-run.js";
import { configureClaudeSharedBrowser } from "./claude-shared-browser-launch.js";
import { claudeCliLifetime } from "./claude-run-lifetime.js";
import { createBoundedCliLines } from "./bounded-cli-lines.js";
import { classifiedClaudeCliFailure, classifiedClaudeFailureEvidence } from "./claude-run-failure.js";
import { createClaudeInputController } from "./claude-input-control.js";
import { createCanonicalCliHumanWait } from "./cli-human-wait.js";
import { CALL_TOOL, createClaudeCustomMcpApprovalControl } from "./claude-custom-mcp-approval.js";
import { createClaudeBuiltinToolApprovalControl } from "./claude-builtin-tool-approval.js";
import { createClaudeIntegrationApprovalControl } from "./claude-integration-approval.js";
import type { PreviewDrivePlatformClient } from "./preview-drive-platform-client.js";
import type { CustomMcpApprovalClient } from "./custom-mcp-approval-client.js";
import { z } from "zod/v4";
import { classifyClaudeUsageFailure } from "./claude-usage-failure.js";
import {
  ClaudeChatStateSchema, buildClaudeChatLaunch, claudeChatLaunchEnvironment, claudeChatPermissionMode,
  finishClaudeChatLaunch, prepareClaudeNativeRecovery, type ClaudeChatState, type ClaudeNativeRecoveryLaunchInput,
  type ClaudeNativeRecoveryLaunchPlan, type ResolveClaudeCredentialLaunch,
} from "./claude-chat-launch.js";
import type { MatrixMcpCapabilityIssuer } from "./matrix-mcp-launch.js";
import {
  buildKernelCredentialLaunch,
  type KernelCredentialLaunch,
} from "../kernel-credentials.js";
import {
  CanonicalProviderRunEventSchema,
  parseCanonicalProviderRunInput,
  type CanonicalChatProviderAdapter,
  type CanonicalProviderRunEvent,
  type CanonicalProviderRunInput,
} from "./provider-adapter.js";
import {
  CanonicalCliError,
  createCanonicalCliEventQueue,
  runCanonicalCli,
  type CanonicalCliSpawn,
} from "./cli-process.js";
import {
  ASSISTANT_CREDENTIAL_BOUNDARY_PROBE_LIMIT,
  classifyAssistantCredentialBoundaryPrefix,
  createAssistantTextStreamProjector,
  isCompleteAssistantCredentialKeyword,
  sanitizeAssistantText,
  projectAssistantTextWithCaptures,
  type CapturedAssistantText,
} from "./safe-activity-projection.js";
import { projectClaudeToolPreview, claudeActivity, canonicalClaudeActivityEvent, type ClaudeActivity } from "./claude-tool-preview.js";
import { createAssistantCredentialEmitter } from "./assistant-credential-emitter.js";

export type { ClaudeNativeRecoveryLaunchInput, ClaudeNativeRecoveryLaunchPlan } from "./claude-chat-launch.js";

const ClaudeStreamLineSchema = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  model: z.string().min(1).max(160).optional(),
  event: z.object({
    type: z.string(),
    index: z.number().int().min(0).max(10_000).optional(),
    delta: z.object({
      type: z.string().optional(),
      text: z.string().optional(),
      partial_json: z.string().optional(),
    }).passthrough().optional(),
    content_block: z.object({
      type: z.string(),
      id: z.string().min(1).max(128).optional(),
      name: z.string().min(1).max(160).optional(),
      input: z.unknown().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

// Claude's stream-json protocol repeats bounded tool-result envelopes throughout
// a Run, so healthy repository tasks routinely exceed one MiB in total. This is
// still a hard process-output ceiling; per-event projection and the queue remain
// independently bounded below.
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 8_192;

export interface ClaudeChatProviderAdapter extends CanonicalChatProviderAdapter<ClaudeChatState> {
  bindNativeScheduledHandler(handler: (request: NativeScheduledPhaseRequest) => Promise<void>): void;
  closeNativeSessions(): Promise<void>;
  prepareNativeRecovery(input: ClaudeNativeRecoveryLaunchInput): Promise<ClaudeNativeRecoveryLaunchPlan | null>;
}

export function createClaudeChatProviderAdapter(options: {
  homePath: string;
  nativeSessions?: ClaudeNativeSessionPool;
  resolveSessionSource?: typeof resolveClaudeSessionSource;
  resolveNativeProtocol?: typeof resolveClaudeNativeProtocol;
  routineCli?: NativeRoutineCliPort;
  credentialKey?: Buffer;
  spawnFn?: CanonicalCliSpawn;
  /** Explicit legacy inactivity override; omitted for ordinary busy owner turns. */
  timeoutMs?: number;
  resolveCredentialEnv?: () => Promise<Record<string, string | undefined> | undefined>;
  /** The run id doubles as the funded priority claim key for this turn. */
  resolveCredentialLaunch?: ResolveClaudeCredentialLaunch;
  sharedBrowser?: SharedBrowserBroker;
  sharedBrowserGatewayPort?: number;
  matrixMcpCapabilityIssuer?: MatrixMcpCapabilityIssuer;
  previewDriveClient?: Pick<PreviewDrivePlatformClient, "grantAction">;
  customMcpApprovalClient?: CustomMcpApprovalClient;
}): ClaudeChatProviderAdapter {
  const activeRuns = new Map<string, {
    ownerId: string;
    ownerType: CanonicalProviderRunInput["owner"]["type"];
    chatId: string;
    abort: () => void;
    steer: (prompt: string) => void;
    submitInput: ReturnType<typeof createClaudeInputController>["submit"];
    submitApproval?: ReturnType<typeof createClaudeCustomMcpApprovalControl>["submit"];
  }>();

  async function* execute(
    inputValue: CanonicalProviderRunInput<ClaudeChatState>,
    resumeState?: ClaudeChatState,
    blockIds = { text: 0, reasoning: 0 },
    approvalReady = true,
  ): AsyncGenerator<CanonicalProviderRunEvent> {
    const input = parseCanonicalProviderRunInput(inputValue);
    const processController = new AbortController();
    let browserRun: NativeSharedBrowserRun | undefined;
    let browserCleanupUnconfirmed = false;
    const closeBrowser = async () => {
      try { await browserRun?.close(); return true; }
      catch (error: unknown) {
        console.warn("[chat-claude] Browser cleanup unavailable", error instanceof Error ? error.name : "UnknownError");
        if (!browserCleanupUnconfirmed) {
          browserCleanupUnconfirmed = true;
          input.onCleanupUnconfirmed?.();
        }
        return false;
      }
    };
    const cwd = input.executionRoot ?? options.homePath;
    const selectedPermission = claudeChatPermissionMode(input.permissionMode, input.interactionMode);
    const fullAccess = selectedPermission === "bypassPermissions";
    // Presentation is projected from the exact scope requested at issuance.
    // A presentation selector never authorizes a Gateway request.
    const mcpScope = approvalReady && input.interactionMode === "default" && selectedPermission !== "plan"
      ? "chat_call" : "chat_discovery";
    const capability = options.matrixMcpCapabilityIssuer?.issue({
      owner: input.owner,
      runId: input.runId,
      // Review is read-only even if its saved permission choice says full access.
      // Unknown future interaction modes receive discovery only.
      scope: mcpScope,
      fullAccess,
      ...(input.context?.drives?.length ? { driveContext: true } : {}),
    }) ?? null;
    if (input.context?.drives?.length && !capability) throw new Error("Company drive tools unavailable");
    const previewDrive = capability?.surface === "preview_drive_call";
    const recipeGuidance = input.context?.agent?.recipe
      ? (capability
          ? previewDrive
            ? "Discover the connected Google Drive account with list_integration_inventory and describe_service. Preserve its exact account label. Only call google_drive/list_files with maxResults from 1 to 3 after this user's approval. "
            : "Discover built-in integrations with list_integration_inventory and describe_service. Preserve the exact account label for calls. "
            + "Discover Custom MCP servers with list_custom_mcp_servers, then inspect enabled tools with describe_custom_mcp_server. "
            + (mcpScope === "chat_call"
              ? "Use call_custom_mcp_tool only when the user needs an enabled tool; the broker owns tool policy and approval."
              : "This run supports discovery only; remote tool calls are unavailable.")
          : "No Matrix tools are available for this run.")
      : undefined;
    const nativePrompt = recipeGuidance ? `${input.prompt}\n\n${recipeGuidance}` : input.prompt;
    let approvalClient = approvalReady && capability && !previewDrive && selectedPermission === "default" && input.interactionMode === "default"
      ? options.customMcpApprovalClient : undefined;
    let registeredGeneration: number | undefined;
    let launch: ReturnType<typeof buildClaudeChatLaunch>;
    let credentialLaunch: KernelCredentialLaunch;
    try {
      browserRun = options.sharedBrowser ? openNativeSharedBrowserRun({ broker: options.sharedBrowser, gatewayPort: options.sharedBrowserGatewayPort ?? 4000, harness: "claude_code" }, { ...input, signal: AbortSignal.any([input.signal, processController.signal]) }) : undefined;
      launch = buildClaudeChatLaunch({
        input, homePath: options.homePath, prompt: input.prompt, permissionMode: selectedPermission,
        matrixCustomMcp: capability !== null,
        matrixCustomMcpScope: previewDrive ? "preview_drive_call" : mcpScope,
      });
      if (browserRun) configureClaudeSharedBrowser(launch, browserRun);
      finishClaudeChatLaunch(launch, resumeState?.canonicalHistoryRequired ? undefined : resumeState?.sessionId);
      credentialLaunch = options.resolveCredentialLaunch
        ? await options.resolveCredentialLaunch({ runId: input.runId, instanceId: input.selection.instanceId })
        : {
            env: await (
              options.resolveCredentialEnv
              ?? (() => buildKernelCredentialLaunch(options.homePath, process.env, undefined, undefined, {
                requestClass: "interactive",
              }).then((value) => value.env))
            )(),
          };
      if (approvalClient) {
        try {
          const registered = await approvalClient.registerRun(input.runId);
          if (!registered || !Number.isSafeInteger(registered.generation) || registered.generation < 1) {
            console.warn("[chat-claude] Custom MCP approval registration unavailable");
            approvalClient = undefined;
          } else {
            registeredGeneration = registered.generation;
          }
        } catch (error: unknown) {
          console.warn("[chat-claude] Custom MCP approval registration failed", error instanceof Error ? error.name : "UnknownError");
          approvalClient = undefined;
        }
      }
    } catch (error: unknown) {
      capability?.revoke();
      await closeBrowser();
      throw error;
    }
    const runEnv = claudeChatLaunchEnvironment(launch, credentialLaunch.env ?? process.env);
    if (browserRun) Object.assign(runEnv, browserRun.mcpServer.env);
    if (capability) {
      // The MCP child receives only this actor/run capability, never the VPS
      // machine bearer. The wrapper requires the scoped bearer for this launch.
      runEnv.MATRIX_AGENT_INTEGRATIONS_TOKEN = capability.token;
    }

    const queue = createCanonicalCliEventQueue<CanonicalProviderRunEvent>();
    let stderrEvidence = "";
    let stderrEvidenceBytes = 0;
    let streamedText = false;
    let resultText = "";
    let bufferedResultEvents: CanonicalProviderRunEvent[] = [];
    let sawResult = false;
    let resultFailed = false;
    let usageFailure: ReturnType<typeof classifyClaudeUsageFailure>;
    let resultSubtype: "success" | "error" | "other" | undefined;
    let emittedState = resumeState;
    let protectedSessionId: string | undefined;
    let steerPrompt: string | undefined;
    let cancellationRequested = false;
    const processSignal = AbortSignal.any([input.signal, processController.signal]);
    let finishInput: (() => void) | undefined;
    let writeControl: ((frame: string) => Promise<void>) | undefined;
    let markStarted: (() => void) | undefined;
    const humanWait = createCanonicalCliHumanWait(event => queue.push(event));
    const approvalControl = approvalClient && registeredGeneration ? createClaudeCustomMcpApprovalControl({
      runId: input.runId, generation: registeredGeneration, client: approvalClient,
      emit: humanWait.emit,
      onError: error => console.warn("[chat-claude] Custom MCP approval failed", error instanceof Error ? error.name : "UnknownError"),
    }) : undefined;
    const integrationApproval = capability ? createClaudeIntegrationApprovalControl({
      runId: input.runId, homePath: options.homePath, capability,
      verify: options.customMcpApprovalClient?.verifyIntegrationDecision?.bind(options.customMcpApprovalClient),
      ...(previewDrive && options.previewDriveClient ? { previewDriveClient: options.previewDriveClient } : {}),
      emit: humanWait.emit, onError: () => processController.abort(),
    }) : undefined;
    const verifyBuiltinToolDecision = options.customMcpApprovalClient?.verifyIntegrationDecision?.bind(options.customMcpApprovalClient);
    // Auto Accept Edits still asks for non-edit tools; Auto's classifier refusals are deliberate and stay denied.
    const builtinToolApproval = verifyBuiltinToolDecision
      && (selectedPermission === "default" || selectedPermission === "acceptEdits")
      && input.interactionMode === "default"
      ? createClaudeBuiltinToolApprovalControl({
        runId: input.runId, chatId: input.chatId, homePath: options.homePath, verify: verifyBuiltinToolDecision,
        emit: humanWait.emit,
        onError: () => processController.abort(),
      }) : undefined;
    let approvalRevoked = false;
    let finalRevokePromise: Promise<void> | undefined;
    let clearApprovalPromise: Promise<boolean> | undefined;
    const revokeApproval = (reason: "final" | "steer" = "final") => {
      inputControl.close();
      capability?.revoke();
      approvalControl?.close();
      integrationApproval?.close();
      builtinToolApproval?.close();
      if (reason === "steer") {
        if (approvalClient && registeredGeneration && !clearApprovalPromise) {
          clearApprovalPromise = approvalClient.clearRunApprovals(input.runId, registeredGeneration)
            .then(result => result.generation === registeredGeneration! + 1)
            .catch(error => {
              console.warn("[chat-claude] Custom MCP steer clear failed", error instanceof Error ? error.name : "UnknownError");
              return false;
            });
        }
        return;
      }
      if (approvalClient && !approvalRevoked) {
        approvalRevoked = true;
        finalRevokePromise = approvalClient.revokeRun(input.runId).then(() => undefined).catch(error => {
          console.warn("[chat-claude] Custom MCP Run revoke failed", error instanceof Error ? error.name : "UnknownError");
        });
      }
    };
    const inputControl = createClaudeInputController({
      signal: processSignal,
      write: frame => writeControl ? writeControl(frame) : Promise.reject(new Error("Input transport unavailable")),
      emit: humanWait.emit,
      onError: () => processController.abort(),
      onToolPermission: (request, respond) => integrationApproval?.onToolPermission(request, respond)
        || (approvalControl?.onToolPermission ?? (approvalReady && capability && !previewDrive && selectedPermission === "default"
        && input.interactionMode === "default" ? (request, respond) => {
          if (request.toolName !== CALL_TOOL) return false;
          // The broker remains the policy authority. An unavailable approval
          // bridge can use allow-policy tools, while always_ask has no receipt.
          const unapprovedInput = Object.fromEntries(Object.entries(request.input)
            .filter(([key]) => key !== "approval_receipt"));
          void respond({ behavior: "allow", updatedInput: unapprovedInput }).catch(error => {
            console.warn("[chat-claude] Custom MCP permission response failed", error instanceof Error ? error.name : "UnknownError");
            processController.abort();
          });
          return true;
        } : undefined))?.(request, respond)
        || builtinToolApproval?.onToolPermission(request, respond)
        || false,
      onToolPermissionCancel: id => {
        integrationApproval?.onToolPermissionCancel(id);
        approvalControl?.onToolPermissionCancel(id);
        builtinToolApproval?.onToolPermissionCancel(id);
      },
    });
    const activeRun = {
      ownerId: input.owner.ownerId,
      ownerType: input.owner.type,
      chatId: input.chatId,
      abort: () => { cancellationRequested = true; revokeApproval(); processController.abort(); },
      submitInput: inputControl.submit,
      submitApproval: async (id: string, decision: Parameters<NonNullable<typeof approvalControl>["submit"]>[1], provenance?: Parameters<NonNullable<typeof approvalControl>["submit"]>[2]) => {
        if (integrationApproval?.has(id)) return integrationApproval.submit(id, decision, provenance);
        if (builtinToolApproval?.has(id)) return builtinToolApproval.submit(id, decision, provenance);
        if (approvalControl) return approvalControl.submit(id, decision, provenance);
        throw new Error("Approval unavailable");
      },
      steer(prompt: string) {
        if (!emittedState) throw new Error("Claude Run state unavailable");
        steerPrompt = prompt;
        revokeApproval("steer");
        processController.abort();
      },
    };
    if (!activeRuns.has(input.runId) && activeRuns.size >= 100) {
      const oldest = activeRuns.keys().next().value;
      if (oldest !== undefined) {
        activeRuns.get(oldest)?.abort();
        activeRuns.delete(oldest);
      }
    }
    activeRuns.set(input.runId, activeRun);
    const releaseActiveRun = () => {
      if (activeRuns.get(input.runId) === activeRun) activeRuns.delete(input.runId);
    };
    let pendingDelta = "";
    let pendingCaptures: CapturedAssistantText["captures"] = [];
    let pendingDeltaMessageId: string | undefined;
    let deltaFlushScheduled = false;
    const pathProjection = {
      homePath: options.homePath,
      executionRoot: input.executionRoot,
      showPrivatePaths: !input.sharedScopeId,
    };
    const textProjector = createAssistantTextStreamProjector(pathProjection);
    const credentialEmitter = createAssistantCredentialEmitter({
      ownerType: input.owner.type,
      ownerId: input.owner.ownerId, chatId: input.chatId, runId: input.runId,
      key: options.credentialKey, sharedScopeId: input.sharedScopeId,
    });
    let projectedMessageId: string | undefined;
    let boundaryProbe: {
      originMessageId?: string;
      text: string;
      segments: Array<{ messageId?: string; text: string }>;
    } | undefined;
    let droppingBoundaryProbe = false;
    const textMessageByIndex = new Map<number, string>();
    const toolInputByIndex = new Map<number, string>();
    const toolNameByIndex = new Map<number, string>();
    const activityByIndex = new Map<number, ClaudeActivity>();

    const flushPendingDelta = () => {
      deltaFlushScheduled = false;
      if (!pendingDelta) return;
      const text = pendingDelta;
      const captures = pendingCaptures;
      const messageId = pendingDeltaMessageId;
      pendingDelta = "";
      pendingCaptures = [];
      pendingDeltaMessageId = undefined;
      for (const event of credentialEmitter.emit({ text, captures }, messageId)) queue.push(event);
    };

    const enqueueDelta = (delta: string, messageId?: string, captures: CapturedAssistantText["captures"] = []) => {
      if (pendingDelta && pendingDeltaMessageId !== messageId) flushPendingDelta();
      pendingDeltaMessageId = messageId;
      pendingCaptures.push(...captures.slice(0, Math.max(0, 16 - pendingCaptures.length))
        .map((capture) => ({ ...capture, offset: capture.offset + pendingDelta.length })));
      pendingDelta += delta;
      if (pendingDelta.length >= 4_000) {
        flushPendingDelta();
      } else if (!deltaFlushScheduled) {
        deltaFlushScheduled = true;
        queueMicrotask(flushPendingDelta);
      }
    };

    const redactProbeSegments = (segments: Array<{ messageId?: string; text: string }>) => {
      for (let index = 0; index < segments.length; index++) {
        const messageId = segments[index]!.messageId;
        if (segments.findIndex((segment) => segment.messageId === messageId) === index) {
          enqueueDelta("[redacted]", messageId);
        }
      }
    };

    const flushProjectedText = () => {
      if (boundaryProbe) {
        // At successful completion, an exact keyword cannot acquire a later
        // marker. Release it only when the old context cannot make it a token.
        const ordinaryCompletedKeyword = textProjector.hasNonCredentialPathContext()
          && isCompleteAssistantCredentialKeyword(boundaryProbe.text);
        const projected = textProjector.flushIndependentBoundaryCaptured();
        if (projected.text) enqueueDelta(projected.text, projectedMessageId, projected.captures);
        if (ordinaryCompletedKeyword) {
          for (const segment of boundaryProbe.segments) {
            const word = sanitizeAssistantText(segment.text, pathProjection);
            if (word) enqueueDelta(word, segment.messageId);
          }
        } else redactProbeSegments(boundaryProbe.segments);
        boundaryProbe = undefined;
        projectedMessageId = undefined;
      }
      droppingBoundaryProbe = false;
      const projected = textProjector.flushCaptured();
      if (projected.text) enqueueDelta(projected.text, projectedMessageId, projected.captures);
      projectedMessageId = undefined;
    };
    const flushSafeProjectedText = (nextCharacter?: string) => {
      const projected = textProjector.flushBoundary(nextCharacter);
      if (projected) enqueueDelta(projected, projectedMessageId);
      if (!textProjector.hasPending()) projectedMessageId = undefined;
    };
    const discardProjectedText = () => {
      textProjector.discard();
      projectedMessageId = undefined;
      boundaryProbe = undefined;
      droppingBoundaryProbe = false;
    };
    const flushIndependentProjectedText = () => {
      const projected = textProjector.flushIndependentBoundaryCaptured();
      if (projected.text) enqueueDelta(projected.text, projectedMessageId, projected.captures);
      projectedMessageId = undefined;
    };
    const projectResolvedDelta = (delta: string, messageId?: string) => {
      if (projectedMessageId !== messageId) {
        flushSafeProjectedText(String.fromCodePoint(delta.codePointAt(0)!));
      }
      if (textProjector.hasPending() && projectedMessageId !== messageId) {
        // A token started in the previous text block. Attribute only its
        // continuation to that block; the rest belongs to the new block.
        let offset = 0;
        for (const character of delta) {
          const projected = textProjector.pushCaptured(character);
          if (projected.text) enqueueDelta(projected.text, projectedMessageId, projected.captures);
          offset += character.length;
          if (!textProjector.hasPending()) {
            projectedMessageId = messageId;
            const remainder = textProjector.pushCaptured(delta.slice(offset));
            if (remainder.text) enqueueDelta(remainder.text, messageId, remainder.captures);
            return;
          }
        }
        return;
      }
      projectedMessageId = messageId;
      const projected = textProjector.pushCaptured(delta);
      if (projected.text) enqueueDelta(projected.text, messageId, projected.captures);
    };
    const projectDelta = (delta: string, messageId?: string) => {
      if (droppingBoundaryProbe) return;
      if (!boundaryProbe && projectedMessageId !== messageId) {
        flushSafeProjectedText(String.fromCodePoint(delta.codePointAt(0)!));
        if (textProjector.hasPending() && projectedMessageId !== messageId) {
          boundaryProbe = { originMessageId: messageId, text: "", segments: [] };
        }
      }
      if (!boundaryProbe) {
        projectResolvedDelta(delta, messageId);
        return;
      }
      let offset = 0;
      for (const character of delta) {
        const probe = boundaryProbe;
        probe.text += character;
        const last = probe.segments.at(-1);
        if (last && last.messageId === messageId) last.text += character;
        else probe.segments.push({ messageId, text: character });
        offset += character.length;
        if (probe.text.length > ASSISTANT_CREDENTIAL_BOUNDARY_PROBE_LIMIT) {
          flushIndependentProjectedText();
          enqueueDelta("[redacted]", probe.originMessageId);
          boundaryProbe = undefined;
          droppingBoundaryProbe = true;
          return;
        }
        // A later block can restart a standalone credential while an earlier
        // block's prefix is unresolved. Classify only observed block starts,
        // within the same capped probe, before replaying any raw candidate.
        let suffix = "";
        let standaloneIndex: number | undefined;
        let hasPendingCandidate = false;
        for (let index = probe.segments.length - 1; index >= 0; index--) {
          suffix = probe.segments[index]!.text + suffix;
          const status = classifyAssistantCredentialBoundaryPrefix(suffix);
          if (status === "standalone") standaloneIndex = index;
          if (status === "pending") hasPendingCandidate = true;
        }
        if (standaloneIndex === undefined && hasPendingCandidate) continue;
        boundaryProbe = undefined;
        if (standaloneIndex !== undefined) {
          flushIndependentProjectedText();
          redactProbeSegments(probe.segments.slice(0, standaloneIndex));
        }
        for (const segment of probe.segments.slice(standaloneIndex ?? 0)) {
          projectResolvedDelta(segment.text, segment.messageId);
        }
        const remainder = delta.slice(offset);
        if (remainder) projectResolvedDelta(remainder, messageId);
        return;
      }
    };

    const routineController = new AbortController();
    const routineSignal = AbortSignal.any([processSignal, routineController.signal]);
    const routineExecution = options.routineCli ? createClaudeRoutineExecution({ ...options.routineCli, input, signal: routineSignal,
      current: () => activeRuns.get(input.runId) === activeRun, publish: humanWait.emit, cwd, homePath: options.homePath }) : undefined;
    const initialInput = () => writeControl!(`${JSON.stringify({ type: "user", session_id: resumeState?.sessionId ?? "", message: { role: "user", content: nativePrompt }, parent_tool_use_id: null })}\n`);
    const routineHook = routineExecution ? createClaudeRoutineHook({ signal: routineSignal,
      write: frame => writeControl!(frame), startInput: initialInput, fail: () => processController.abort(), execute: routineExecution.execute }) : undefined;
    const closeRoutines = async () => { routineController.abort(); await routineHook?.close(); await routineExecution?.close(); };
    const observeSessionState = (sessionId: string, model?: string) => {
      if (protectedSessionId && sessionId !== protectedSessionId) throw new CanonicalCliError("invalid_output");
      const canonicalHistoryRequired = protectedSessionId === sessionId ? true : undefined;
      if (sessionId === emittedState?.sessionId && (model === undefined || model === emittedState.model)
        && canonicalHistoryRequired === emittedState.canonicalHistoryRequired) return;
      const currentModel = model ?? (sessionId === emittedState?.sessionId ? emittedState.model : undefined);
      flushPendingDelta();
      const state = ClaudeChatStateSchema.parse({
        sessionId, ...(currentModel ? { model: currentModel } : {}),
        ...(canonicalHistoryRequired ? { canonicalHistoryRequired } : {}),
      });
      emittedState = state;
      queue.push(CanonicalProviderRunEventSchema.parse({ type: "state.updated", state }));
    };
    const parseLine = (raw: string) => {
      if (!raw.trim()) return;
      const line = ClaudeStreamLineSchema.parse(JSON.parse(raw));
      markStarted?.();
      if (routineHook?.handle(line)) return;
      if (inputControl.handle(line)) return;
      if (line.type === "result") {
        if (line.is_error === true || line.subtype === "error") discardProjectedText();
        else flushProjectedText();
      }
      if (usageFailure?.category !== "quota_exhausted") {
        usageFailure = classifyClaudeUsageFailure(line) ?? usageFailure;
      }
      if (line.session_id) observeSessionState(line.session_id, line.model);
      const delta = line.type === "stream_event"
        && line.event?.type === "content_block_delta"
        && line.event.delta?.type === "text_delta"
        ? line.event.delta.text
        : undefined;
      if (delta) {
        streamedText = true;
        projectDelta(delta, line.event?.index === undefined ? undefined : textMessageByIndex.get(line.event.index));
      }
      if (line.type === "stream_event" && line.event?.type === "content_block_delta"
        && line.event.index !== undefined && line.event.delta?.type === "input_json_delta"
        && line.event.delta.partial_json) {
        const current = toolInputByIndex.get(line.event.index) ?? "";
        if (current.length + line.event.delta.partial_json.length <= 16_000) {
          toolInputByIndex.set(line.event.index, `${current}${line.event.delta.partial_json}`);
        }
      }
      if (line.type === "stream_event" && line.event?.type === "content_block_start"
        && line.event.index !== undefined && line.event.content_block) {
        flushSafeProjectedText();
        flushPendingDelta();
        const block = line.event.content_block;
        if (block.type === "text") {
          textMessageByIndex.set(line.event.index, `claude_text_${blockIds.text++}`);
        } else if (block.type === "thinking") {
          const activity = {
            activityId: `reasoning_${blockIds.reasoning++}`,
            kind: "reasoning" as const,
            label: "Thinking",
          };
          activityByIndex.set(line.event.index, activity);
          queue.push(canonicalClaudeActivityEvent(activity, "running"));
        } else if (block.type === "tool_use" && block.id && block.name) {
          const activity = {
            activityId: block.id,
            ...claudeActivity(block.name),
            ...projectClaudeToolPreview(block.name, block.input, pathProjection),
          };
          activityByIndex.set(line.event.index, activity);
          toolInputByIndex.set(line.event.index, "");
          toolNameByIndex.set(line.event.index, block.name);
          queue.push(canonicalClaudeActivityEvent(activity, "running"));
        }
      }
      if (line.type === "stream_event" && line.event?.type === "content_block_stop"
        && line.event.index !== undefined) {
        flushSafeProjectedText();
        flushPendingDelta();
        const activity = activityByIndex.get(line.event.index);
        if (activity) {
          activityByIndex.delete(line.event.index);
          const partialInput = toolInputByIndex.get(line.event.index);
          toolInputByIndex.delete(line.event.index);
          const toolName = toolNameByIndex.get(line.event.index);
          toolNameByIndex.delete(line.event.index);
          let completedActivity = activity;
          if (partialInput && toolName) {
            try {
              const parsedInput: unknown = JSON.parse(partialInput);
              completedActivity = {
                ...activity,
                ...projectClaudeToolPreview(toolName, parsedInput, pathProjection),
              };
            } catch (error: unknown) {
              console.warn("[chat-claude] Ignoring malformed bounded tool input:", error instanceof Error ? error.name : "UnknownError");
            }
          }
          queue.push(canonicalClaudeActivityEvent(completedActivity, "completed"));
        }
        textMessageByIndex.delete(line.event.index);
      }
      if (line.type === "result") {
        sawResult = true;
        routineController.abort(); // Actual native turn terminal, independent of a completed tool/CLI invocation.
        resultSubtype = line.subtype === "success" || line.subtype === "error"
          ? line.subtype
          : line.subtype === undefined
            ? undefined
            : "other";
        const projectedResult = projectAssistantTextWithCaptures(line.result ?? "", pathProjection);
        resultText = projectedResult.text;
        resultFailed = line.is_error === true || line.subtype === "error";
        if (!resultFailed && !streamedText) bufferedResultEvents = credentialEmitter.emit(projectedResult);
        finishInput?.();
      }
    };

    const emitBufferedResult = () => {
      if (!resultFailed && !streamedText && resultText) {
        for (const event of bufferedResultEvents) queue.push(event);
        bufferedResultEvents = [];
      }
    };

    const lines = createBoundedCliLines(MAX_FRAME_BYTES, parseLine);
    const runPhase = options.nativeSessions ? async (transport: Parameters<typeof runCanonicalCli>[0]) => {
      const preparingAt = Date.now();
      const remainingLifetime = () => {
        if (transport.timeoutMs === undefined) return {};
        const timeoutMs = transport.timeoutMs - (Date.now() - preparingAt);
        if (timeoutMs <= 0) throw new CanonicalCliError("timeout");
        return { timeoutMs };
      };
      try {
        const protocol = await (options.resolveNativeProtocol ?? resolveClaudeNativeProtocol)({
          command: transport.command, cwd: transport.cwd, env: transport.env, signal: transport.signal,
          spawnFn: transport.spawnFn, timeoutMs: transport.timeoutMs,
        });
        transport.signal.throwIfAborted();
        if (!protocol.qualified) {
          if (input.nativeScheduled) throw new Error("Native scheduled protocol unavailable");
          await options.nativeSessions!.retireIdle(input);
          if (resumeState?.canonicalHistoryRequired) throw new Error("Native protected session unavailable");
          if (transport.signal.aborted) throw new CanonicalCliError("aborted");
          return await runCanonicalCli({ ...transport, command: protocol.command,
            args: disallowNativeCronCreate(transport.args), ...remainingLifetime() });
        }
        const source = await (options.resolveSessionSource ?? resolveClaudeSessionSource)({
          homePath: options.homePath, command: protocol.command, cwd: launch.cwd, args: launch.args, env: runEnv, input,
        });
        return await options.nativeSessions!.runTurn({ ...transport, command: protocol.command, ...remainingLifetime(),
          input, sourceFingerprint: source.fingerprint, schedulingAllowed: source.schedulingAllowed,
          requireProtectedSession: resumeState?.canonicalHistoryRequired,
          onProtectedSession(sessionId) { protectedSessionId = sessionId; observeSessionState(sessionId); },
        });
      } catch (error: unknown) {
        if (error instanceof ClaudeNativeProbeCleanupError) input.onCleanupUnconfirmed?.();
        await cancelScheduledSource(input);
        throw transport.signal.aborted ? new CanonicalCliError("aborted") : error;
      }
    } : runCanonicalCli;
    void runPhase({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: runEnv,
      replaceEnv: true,
      signal: processSignal,
      ...claudeCliLifetime({ idleTimeoutMs: options.timeoutMs,
        fundedRunTimeoutMs: credentialLaunch.fundedRunTimeoutMs }),
      maxStdoutBytes: MAX_FRAME_BYTES,
      stdoutLimitMode: "caller_bounded_frames",
      maxStderrBytes: MAX_STDERR_BYTES,
      spawnFn: options.spawnFn,
      onSettled: () => routineController.abort(),
      onStart(write, end, idle, startup) {
        markStarted = () => startup.ready();
        humanWait.attach(idle);
        writeControl = write;
        finishInput = end;
        void (routineHook ? routineHook.start() : initialInput()).catch(error => {
          console.warn("[chat-claude] Initial input write failed", error instanceof Error ? error.name : "UnknownError");
          processController.abort();
        });
      },
      onStdout(chunk) {
        lines.push(chunk);
      },
      onStderr(chunk) {
        stderrEvidence += chunk.toString("utf8");
        stderrEvidenceBytes += chunk.byteLength;
      },
    }).then(async () => {
      await closeRoutines();
      releaseActiveRun();
      lines.finish();
      if (sawResult && !resultFailed) flushProjectedText();
      else discardProjectedText();
      flushPendingDelta();
      emitBufferedResult();
      const classifiedFailure = usageFailure ?? (resultFailed
        ? classifiedClaudeFailureEvidence(`${resultText}\n${stderrEvidence}`)
        : undefined);
      if (!sawResult || resultFailed) {
        console.warn("[chat-claude] Claude CLI result did not complete the Run", {
          category: classifiedFailure?.category ?? (resultFailed ? "result_error" : "missing_result"),
          resultSubtype,
          resultHasText: resultText.length > 0,
          stderrEvidenceBytes,
        });
      }
      queue.push(CanonicalProviderRunEventSchema.parse(!sawResult || resultFailed
        ? {
            type: "run.completed",
            outcome: "failed",
            error: classifiedFailure?.safeError ?? (resultFailed
              ? {
                  code: "run_failed",
                  safeMessage: "Claude reported a failure before completing this Run. Try again, or open Claude setup if it continues.",
                  retryable: true,
                  recoveryActions: ["retry", "open_setup_terminal"],
                }
              : classifiedClaudeCliFailure(new CanonicalCliError("invalid_output"))!.safeError),
          }
        : { type: "run.completed", outcome: "completed" }));
      queue.finish();
    }).catch(async (error: unknown) => {
      if (sawResult && !resultFailed) flushProjectedText();
      else {
        if (error instanceof CanonicalCliError && error.kind === "aborted" && !resultFailed
          && steerPrompt && emittedState && !input.signal.aborted && !cancellationRequested
          && activeRuns.get(input.runId) === activeRun && !boundaryProbe) {
          // An accepted Steer ends this text context. Preserve an ordinary
          // safe tail, but leave path/URL/credential candidates for discard.
          flushSafeProjectedText("\n");
        }
        discardProjectedText();
      }
      flushPendingDelta();
      if (steerPrompt && emittedState && !input.signal.aborted) {
        if (!await closeBrowser()) {
          releaseActiveRun();
          queue.push({ type: "run.completed", outcome: "failed", error: { code: "run_failed", safeMessage: "Browser cleanup could not be confirmed. Try again after restoring browser control.", retryable: true, recoveryActions: ["retry"] } });
          queue.finish(); return;
        }
        capability?.revoke();
        const cleared = await (clearApprovalPromise ?? Promise.resolve(true));
        if (cancellationRequested || input.signal.aborted || activeRuns.get(input.runId) !== activeRun) {
          releaseActiveRun();
          queue.push(CanonicalProviderRunEventSchema.parse({ type: "run.completed", outcome: "aborted" }));
          queue.finish();
          return;
        }
        if (!cleared && approvalClient) {
          revokeApproval();
          await finalRevokePromise;
          if (cancellationRequested || input.signal.aborted || activeRuns.get(input.runId) !== activeRun) {
            releaseActiveRun();
            queue.push(CanonicalProviderRunEventSchema.parse({ type: "run.completed", outcome: "aborted" }));
            queue.finish();
            return;
          }
        }
        releaseActiveRun();
        for await (const event of execute({
          ...input,
          prompt: steerPrompt,
          nativeScheduled: undefined,
          parts: [{ type: "text", text: steerPrompt }],
          resumeState: emittedState,
        }, emittedState, blockIds, approvalReady && cleared)) {
          queue.push(event);
        }
        queue.finish();
        return;
      }
      releaseActiveRun();
      if (sawResult && !resultFailed) {
        console.warn("[chat-claude] Claude CLI exited non-zero after a successful result", {
          cliFailureKind: error instanceof CanonicalCliError ? error.kind : "unknown",
          exitCode: error instanceof CanonicalCliError ? error.exitCode : undefined,
          signal: error instanceof CanonicalCliError ? error.signal : undefined,
        });
        emitBufferedResult();
        queue.push(CanonicalProviderRunEventSchema.parse({
          type: "run.completed",
          outcome: "completed",
        }));
        queue.finish();
        return;
      }
      const cancelled = input.signal.aborted || (cancellationRequested && error instanceof CanonicalCliError && error.kind === "aborted");
      const classifiedFailure = usageFailure ?? classifiedClaudeFailureEvidence(`${resultText}\n${stderrEvidence}`)
        ?? classifiedClaudeCliFailure(error);
      if (!cancelled) {
        console.warn("[chat-claude] Claude CLI Run failed", {
          category: classifiedFailure?.category ?? "provider_exit",
          cliFailureKind: error instanceof CanonicalCliError ? error.kind : "unknown",
          exitCode: error instanceof CanonicalCliError ? error.exitCode : undefined,
          signal: error instanceof CanonicalCliError ? error.signal : undefined,
          stderrEvidenceBytes,
        });
      }
      queue.push(CanonicalProviderRunEventSchema.parse({
        type: "run.completed",
        outcome: cancelled ? "aborted" : "failed",
        ...(cancelled ? {} : {
          error: classifiedFailure?.safeError ?? {
            code: "run_failed",
            safeMessage: "Claude could not complete this Run. Check its connection and retry.",
            retryable: true,
            recoveryActions: ["retry"],
          },
        }),
      }));
      queue.finish();
    }).catch((error: unknown) => {
      // Replacement executions can fail while draining their browser after
      // terminal events. Finish the forwarding stream with that failure too.
      releaseActiveRun();
      queue.finish(error instanceof Error ? error : new Error("Claude execution unavailable"));
    }).finally(() => { inputControl.close(); humanWait.close(); if (steerPrompt && emittedState && !input.signal.aborted && !cancellationRequested) {
      capability?.revoke(); approvalControl?.close(); integrationApproval?.close(); builtinToolApproval?.close();
    } else revokeApproval(); });

    let streamCompleted = false;
    try {
      yield* queue.values();
      streamCompleted = true;
    } finally {
      processController.abort();
      await closeRoutines();
      inputControl.close(); humanWait.close();
      discardProjectedText();
      if (!streamCompleted) {
        cancellationRequested = true;
        releaseActiveRun();
        revokeApproval();
        await finalRevokePromise;
      } else if (steerPrompt && emittedState && !input.signal.aborted && !cancellationRequested) {
        capability?.revoke(); approvalControl?.close(); integrationApproval?.close(); builtinToolApproval?.close();
      } else revokeApproval();
      capability?.revoke();
      if (!await closeBrowser()) throw new Error("Browser cleanup unconfirmed");
    }
  }

  async function cancelScheduledSource(input: CanonicalProviderRunInput) {
    if (!input.nativeScheduled || !options.nativeSessions) return;
    try { await options.nativeSessions.cancel({ owner: input.owner, chatId: input.chatId,
      runId: input.nativeScheduled.sourceRunId }); }
    catch (error: unknown) {
      input.onCleanupUnconfirmed?.();
      console.warn("[chat-claude] Native scheduled source cleanup unavailable", error instanceof Error ? error.name : "UnknownError");
    }
  }
  async function* guardedExecute(input: CanonicalProviderRunInput<ClaudeChatState>, resume: boolean) {
    try {
      const state = resume ? ClaudeChatStateSchema.parse(input.resumeState) : undefined;
      if ((state?.canonicalHistoryRequired || input.nativeScheduled) && !options.nativeSessions) throw new Error("Native session unavailable");
      yield* execute(input, state);
    }
    catch (error: unknown) { await cancelScheduledSource(input); throw error; }
  }

  return {
    driverKind: "claude_code",
    stateSchemaVersion: 1,
    bindNativeScheduledHandler: handler => { options.nativeSessions?.setScheduledHandler(handler); },
    closeNativeSessions: () => options.nativeSessions?.close() ?? Promise.resolve(),
    prepareNativeRecovery: input => prepareClaudeNativeRecovery({
      homePath: options.homePath, resolveCredentialLaunch: options.resolveCredentialLaunch,
      resolveNativeProtocol: options.resolveNativeProtocol ?? resolveClaudeNativeProtocol,
      resolveSessionSource: options.resolveSessionSource ?? resolveClaudeSessionSource,
      spawnFn: options.spawnFn, matrixCustomMcp: options.matrixMcpCapabilityIssuer !== undefined,
      sharedBrowser: options.sharedBrowser !== undefined,
    }, input),
    parseState: (value) => ClaudeChatStateSchema.parse(value),
    serializeState: (value) => ClaudeChatStateSchema.parse(value),
    selectResumeCheckpoint({ owner, chatId, state, settings, previousSettings }) {
      if (!options.nativeSessions?.hasProtectedSession({ owner, chatId, sessionId: state.sessionId })) {
        return state.canonicalHistoryRequired ? undefined : state;
      }
      if (settings.interactionMode !== previousSettings.interactionMode || settings.permissionMode !== previousSettings.permissionMode
        || !isDeepStrictEqual(settings.selection, previousSettings.selection)) return undefined;
      // Even an unmarked source checkpoint may now belong to an isolated, restored child.
      return { ...state, canonicalHistoryRequired: true };
    },
    start: (input) => guardedExecute(input, false),
    resume: (input) => guardedExecute(input, true),
    async submitInput(input) {
      const active = activeRuns.get(input.runId);
      if (!active || active.ownerId !== input.owner.ownerId || active.ownerType !== input.owner.type || active.chatId !== input.chatId) throw new Error("Input Run unavailable");
      await active.submitInput(input);
    },
    async submitApproval(input) {
      const active = activeRuns.get(input.runId);
      if (!active || active.ownerId !== input.owner.ownerId || active.ownerType !== input.owner.type
        || active.chatId !== input.chatId || !active.submitApproval) throw new Error("Approval Run unavailable");
      await active.submitApproval(input.approvalId, input.decision, {
        chatId: input.chatId, clientRequestId: input.clientRequestId,
        platformApprovalProof: input.platformApprovalProof,
      });
    },
    async cancel(input) {
      const active = activeRuns.get(input.runId);
      if (active && active.ownerId === input.owner.ownerId && active.ownerType === input.owner.type
        && active.chatId === input.chatId) active.abort();
      await options.nativeSessions?.cancel(input);
    },
    async steer(input) {
      const active = activeRuns.get(input.runId);
      if (!active || active.ownerId !== input.owner.ownerId || active.ownerType !== input.owner.type || active.chatId !== input.chatId) {
        throw new Error("Claude active Run unavailable");
      }
      active.steer(input.prompt);
    },
  };
}
