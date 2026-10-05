import { registerNativeCompanion } from "../live-companion/registration.js";
import { createCanonicalLivePort } from "../live-companion/task-broker.js";
import type { GeminiLiveConnection } from "../onboarding/gemini-live.js";
import { createHmac } from "node:crypto";
import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { Context } from "hono";
import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { VoiceExecutionPolicy } from "../voice-session/ports.js";
import type { ChatRepository } from "../chat/repository.js";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import type { CanonicalActionAuthority } from "../chat/action-authority.js";
import type { RequestPrincipal } from "../request-principal.js";
import type { createVoiceSessionPolicyLookup } from "../chat/voice-session-policy.js";
import { AoedeBindingRepository } from "../aoede/binding-repository.js";
import { AoedeBootstrapService, type AoedeBootstrapServiceDeps } from "../aoede/bootstrap-service.js";
import { createAoedeRoutes } from "../aoede/routes.js";
import { ChatVoiceDeliveryRepository } from "../chat/voice-delivery-repository.js";
import { createAdapterCapabilityPort, VoiceMediaAdapterRegistry } from "../voice-session/adapter.js";
import { registerVoiceSessionMediaAdapters } from "../voice-session/adapter-registration.js";
import { createManagedVoiceReadinessProbe, wrapCapabilityPortWithReadiness } from "../speech/managed-readiness.js";
import { canonicalVoiceDecision, createCanonicalVoicePorts } from "../voice-session/canonical-ports.js";
import { VoiceSessionEngine } from "../voice-session/engine.js";
import { createManagedVoiceTranscriptionPort, createManagedVoiceSynthesisPort, createVoiceSessionPlatformSpeechClient } from "../speech/voice-session-ports.js";
import { createVoiceSessionRoutes, projectVoiceCapability, registerVoiceSessionWebSocketRoute } from "../voice-session/routes.js";
import { createVoiceOriginAllowlist, VoiceTicketAuthority } from "../voice-session/ticket-auth.js";
import { createRateLimiter } from "../security/rate-limiter.js";
import { buildAllowedOrigins } from "../allowed-origins.js";

export function registerCanonicalVoice(options: {
  geminiLiveConnection: GeminiLiveConnection;
  app: Hono; upgradeWebSocket: UpgradeWebSocket;
  chatRepository: ChatRepository; canonicalChatOrchestrator: CanonicalChatOrchestrator;
  canonicalActionAuthority?: CanonicalActionAuthority;
  voiceSessionPolicy: ReturnType<typeof createVoiceSessionPolicyLookup>;
  aoedeBindings: AoedeBindingRepository | null;
  voiceReadinessCatalog: AoedeBootstrapServiceDeps["catalog"];
  qualifiedCanonicalPolicyFor(selection: CanonicalChatModelSelection | undefined, catalog: CanonicalProviderCatalog): Promise<VoiceExecutionPolicy | undefined>;
  requireRequestPrincipal(c: Context): RequestPrincipal;
  resolveProject: AoedeBootstrapServiceDeps["resolveProject"];
}) {
  const { app, upgradeWebSocket, chatRepository, canonicalChatOrchestrator, canonicalActionAuthority,
    voiceSessionPolicy, aoedeBindings, voiceReadinessCatalog, qualifiedCanonicalPolicyFor, requireRequestPrincipal } = options;
  let voiceSessionEngine: VoiceSessionEngine | null = null;
  let aoedeBootstrapService: AoedeBootstrapService | null = null;
    // ------------------------------------------------------------------
    // Canonical voice sessions — voice as a mode of exactly one canonical
    // Chat. Finalized speech enters through canonical admission; assistant
    // output/activity arrives from the canonical outbox; the engine owns
    // only ephemeral transport/media state.
    const voiceLog = (event: string, fields: Record<string, unknown>) =>
      console.warn("[voice-session]", event, fields);
    const voiceDeliveries = new ChatVoiceDeliveryRepository(chatRepository.kysely);
    const voicePorts = createCanonicalVoicePorts({
      orchestrator: canonicalChatOrchestrator,
      repository: chatRepository,
      deliveries: voiceDeliveries,
      ...(canonicalActionAuthority ? { actions: canonicalActionAuthority } : {}),
      log: voiceLog,
    });
    const voiceAdapters = new VoiceMediaAdapterRegistry();
    // One registration policy owns adapter authority
    // (`registerVoiceSessionMediaAdapters`): the simulator stays an explicit
    // dev seam; Platform Speech is the only production speech path — the
    // managed adapter transcribes and speaks through the provisioned runtime
    // client. A direct provider key is a non-production escape
    // hatch — never a second key authority on a production gateway.
    const voicePlatformSpeechClient = createVoiceSessionPlatformSpeechClient(process.env);
    const native = registerNativeCompanion({ registry: voiceAdapters, connection: options.geminiLiveConnection, env: process.env });
    const voiceAdapterRegistration = native.requested ? { adapterId: native.available ? "gemini_live" : null, synthesisSource: undefined } : registerVoiceSessionMediaAdapters({
      registry: voiceAdapters,
      env: process.env,
      managedTranscribe: voicePlatformSpeechClient
        ? createManagedVoiceTranscriptionPort({ client: voicePlatformSpeechClient })
        : undefined,
      managedSynthesize: voicePlatformSpeechClient
        ? createManagedVoiceSynthesisPort({ client: voicePlatformSpeechClient })
        : undefined,
      log: voiceLog,
    });
    // Managed speech readiness is authoritative and bounded (≤15s probe, 30s
    // positive / 5s negative cache). Consulted only when the registered adapter
    // is "managed"; every non-ready state fails closed downstream. When the
    // managed adapter's synthesis leg came from a development-gated port, the
    // probe adjudicates only the platform transcription it is authoritative
    // for — it must not fail closed on a synthesis leg the adapter never uses.
    const managedVoiceReadiness = voicePlatformSpeechClient
      ? createManagedVoiceReadinessProbe({
          client: voicePlatformSpeechClient,
          synthesisSource: voiceAdapterRegistration.synthesisSource ?? "platform",
        })
      : undefined;
    const voiceAdapterCapabilities = createAdapterCapabilityPort({
      registry: voiceAdapters,
      limits: native.requested ? { maxSessionSeconds: 1800, maxIdleSeconds: 60 } : { maxSessionSeconds: 3_600, maxIdleSeconds: 300 },
    });
    const voiceCapabilities = managedVoiceReadiness
      ? wrapCapabilityPortWithReadiness({
          port: voiceAdapterCapabilities,
          probe: managedVoiceReadiness,
          selectedAdapterId: () => voiceAdapterRegistration.adapterId,
        })
      : voiceAdapterCapabilities;
    // Single-process authority: customer VPSes run exactly one gateway, so
    // this in-memory map is the complete replay state; replicas would need a
    // shared atomic consume store (see ticket-auth.ts). MATRIX_AUTH_TOKEN
    // also derives the ticket HMAC; without it the authority falls back to a
    // per-process key and outstanding tickets die on restart.
    if (!process.env.MATRIX_AUTH_TOKEN) {
      voiceLog("voice.tickets.ephemeral_key", { note: "MATRIX_AUTH_TOKEN unset; voice transport tickets are not restart-stable" });
    }
    const voiceTickets = new VoiceTicketAuthority({
      hmacKey: process.env.MATRIX_AUTH_TOKEN
        ? createHmac("sha256", process.env.MATRIX_AUTH_TOKEN)
          .update("matrix-os/voice-transport-tickets").digest()
        : undefined,
    });
    voiceSessionEngine = new VoiceSessionEngine({
      admission: voicePorts.admission,
      delivery: voicePorts.delivery,
      chatEvents: voicePorts.chatEvents,
      runControl: voicePorts.runControl,
      adapters: voiceAdapters,
      tickets: voiceTickets,
      log: voiceLog,
      limits: native.requested ? { maxSessionSeconds: 1800, maxIdleSeconds: 60 } : undefined,
      liveHistory: input => createCanonicalLivePort({ repository: chatRepository, orchestrator: canonicalChatOrchestrator,
        taskEvents: voicePorts.chatEvents, principal: { userId: input.principalId, source: input.principalSource }, chatId: input.chatId, selection: input.selection }),
    });
    voiceSessionPolicy?.set(voiceSessionEngine.sessionPolicyLookup);
    const voiceSessionRateLimiter = createRateLimiter({
      maxAttempts: 30,
      windowMs: 60_000,
      lockoutMs: 60_000,
    });
    app.route("/", createVoiceSessionRoutes({
      engine: voiceSessionEngine,
      resolvePrincipal: requireRequestPrincipal,
      chatAccess: voicePorts.chatAccess,
      capabilities: {
        capabilities: async (input) => {
          const capability = await voiceCapabilities.capabilities(input);
          // No canonical harness enforces per-run memory suppression yet, so
          // no surface may claim an enforceable session-only route.
          return capability.status === "available"
            ? { ...capability, sessionOnly: "unsupported" as const }
            : capability;
        },
      },
      // Server-owned canonical authority: persisted Chat selection, provider
      // route eligibility, and the adapter-qualified frozen execution policy.
      // No decision (no persisted selection) fails closed to conversation_only.
      canonicalDecision: async ({ principal, chatId, surface }) => {
        const owner = { type: "personal" as const, ownerId: principal.userId };
        const selection = (await chatRepository!.get(owner, chatId))?.chat.currentSelection;
        if (!selection) return undefined;
        const catalog = await voiceReadinessCatalog.getCatalog(principal, selection.instanceId);
        return canonicalVoiceDecision({
          selection,
          catalog,
          qualifiedPolicy: await qualifiedCanonicalPolicyFor(selection, catalog),
          ...(surface !== undefined ? { surface } : {}),
        });
      },
      checkRateLimit: ({ principal }) => voiceSessionRateLimiter.check(principal.userId),
    }));
    registerVoiceSessionWebSocketRoute({
      app,
      upgradeWebSocket,
      engine: voiceSessionEngine,
      tickets: voiceTickets,
      isOriginAllowed: createVoiceOriginAllowlist(
        buildAllowedOrigins({
          shellOrigin: process.env.SHELL_ORIGIN,
          proxyOrigin: process.env.PROXY_ORIGIN,
        }),
        // Native/Electron WebSocket clients send no Origin header; the ticket
        // itself carries the session/principal/path binding.
        { allowMissing: true },
      ),
      log: voiceLog,
    });

    // ------------------------------------------------------------------
    // Aoede standalone assistant bootstrap — an authenticated owner-local
    // pointer to exactly one canonical Chat per runtime/scope. Runtime
    // identity is server configuration only; request fields never supply it.
    // No dispatch, microphone, or provider run starts here.
    const aoedeMachineId = process.env.MATRIX_MACHINE_ID?.trim();
    const aoedeRuntimeSlot = process.env.MATRIX_RUNTIME_SLOT?.trim();
    if (aoedeBindings && aoedeMachineId && aoedeRuntimeSlot) {
      try {
        aoedeBootstrapService = new AoedeBootstrapService({
          repository: aoedeBindings,
          catalog: voiceReadinessCatalog,
          runtimeIdentity: { machineId: aoedeMachineId, runtimeSlot: aoedeRuntimeSlot },
          resolveProject: async (principal, projectId) => {
            return options.resolveProject(principal, projectId);
          },
          // Speech readiness is independent of the selected model and Chat;
          // overlap its bounded probe with cold canonical catalog discovery.
          resolveSpeechCapability: async ({ principal, surface }) => voiceCapabilities.capabilities({
            principalId: principal.userId, chatId: "aoede_bootstrap", surface,
          }),
          resolveReadiness: async ({ principal, surface, selection, catalog, speechCapability }) => ({
            // The exact requested/saved selection is authoritative — the
            // service rejects any substituted route, so never substitute.
            selection,
            capability: projectVoiceCapability(
              // The Chat may not exist yet; adapter capability is not chat-scoped.
              speechCapability ?? await voiceCapabilities.capabilities({
                principalId: principal.userId, chatId: "aoede_bootstrap", surface,
              }),
              canonicalVoiceDecision({
                selection,
                catalog,
                surface,
                qualifiedPolicy: await qualifiedCanonicalPolicyFor(selection, catalog),
              }),
            ),
          }),
        });
        app.route("/", createAoedeRoutes({
          service: aoedeBootstrapService,
          requirePrincipal: requireRequestPrincipal,
        }));
      } catch (error: unknown) {
        aoedeBootstrapService = null;
        console.warn("[aoede] bootstrap service unavailable:",
          error instanceof Error ? error.name : "UnknownError");
      }
    }
  return { voiceSessionEngine, aoedeBootstrapService };
}
