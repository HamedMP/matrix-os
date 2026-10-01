/**
 * The gateway's single scope-runtime host (spec 536, research R4): one
 * supervisor client and one broker socket, started whenever the scope
 * runtime is available, whether or not collaboration is configured.
 * Registries (shared AI, private bots) register an authorizer; the broker
 * authorizes each frame through the one registry that owns its runtime
 * handle and generation. A handle claimed by none, or by more than one, is
 * denied.
 */
import type { ScopeRuntimeBrokerRequest } from "@matrix-os/scope-runtime/broker-protocol";
import { z } from "zod/v4";
import type { FundedAdmissionQueue } from "../funded-ai/admission-queue.js";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import {
  createScopeRuntimeBroker,
  createScopeRuntimeBrokerServer,
  type ScopeRuntimeBrokerAuthorization,
} from "../collaboration/scope-runtime-broker.js";
import { createScopeRuntimeClient, type ScopeRuntimeProfileCatalog } from "../collaboration/scope-runtime-client.js";

const SUPERVISOR_SOCKET = "/run/matrix-scope-runtime/supervisor.sock";
const BROKER_SOCKET = "/run/matrix-scope-runtime/broker.sock";
/** Shared AI and private bots today; the cap keeps registration bounded. */
const MAX_AUTHORIZERS = 4;
const AUTHORIZER_ID = /^[a-z][a-z0-9_]{0,31}$/;

export interface ScopeRuntimeAuthorizationRequest {
  runtimeHandle: string;
  executionGeneration: string;
  requestId: string;
  action: ScopeRuntimeBrokerRequest["action"];
  modelId?: string;
  url?: string;
}

export interface ScopeRuntimeAuthorizer {
  /**
   * Names the registry, such as `shared_ai` or `bots`. Registering the same
   * id again replaces the earlier registration, so a restarted registry
   * never leaves a stale one behind.
   */
  id: string;
  /** True when this registry bound the runtime handle at this generation. */
  owns(input: { runtimeHandle: string; executionGeneration: string }): boolean;
  authorize(request: ScopeRuntimeAuthorizationRequest): Promise<ScopeRuntimeBrokerAuthorization>;
  /**
   * Optional: take whole frames from runtimes this registry owns (bot
   * workloads use their own frame shapes). Resolve undefined to drop an
   * invalid frame.
   */
  handleFrame?(raw: unknown): Promise<Record<string, unknown> | undefined>;
}

const FrameOwnerSchema = z.object({
  runtimeHandle: z.string().max(64),
  executionGeneration: z.string().max(24),
}).passthrough();

export type ScopeRuntimeHostClient = ReturnType<typeof createScopeRuntimeClient>;

export interface ScopeRuntimeHost {
  readonly client: ScopeRuntimeHostClient;
  /** False when the supervisor was unavailable at start; nothing listens then. */
  readonly available: boolean;
  /** Returns the function that removes this registration (and not one that replaced it). */
  registerAuthorizer(authorizer: ScopeRuntimeAuthorizer): () => void;
  close(): Promise<void>;
}

export class ScopeRuntimeHostError extends Error {
  constructor(readonly code: "closed" | "capacity_exceeded" | "invalid_authorizer") {
    super(`Scope runtime host refused the registration: ${code}`);
    this.name = "ScopeRuntimeHostError";
  }
}

export async function createScopeRuntimeHost(options: {
  homePath: string;
  profileCatalog: ScopeRuntimeProfileCatalog;
  supervisorSocket?: string;
  brokerSocket?: string;
  fundedCredentialProvider?: MatrixFundedCredentialProvider;
  fundedAdmission?: FundedAdmissionQueue;
  fetchImpl?: typeof fetch;
}): Promise<ScopeRuntimeHost> {
  const client = createScopeRuntimeClient({
    socketPath: options.supervisorSocket ?? SUPERVISOR_SOCKET,
    profileCatalog: options.profileCatalog,
  });
  /** At most MAX_AUTHORIZERS, keyed by registry id; a new registration for an id evicts the old one. */
  const authorizers = new Map<string, ScopeRuntimeAuthorizer>();
  let closed = false;

  const unavailable = (): ScopeRuntimeHost => ({
    client,
    available: false,
    registerAuthorizer: () => () => undefined,
    async close() {
      closed = true;
      await client.close();
    },
  });

  const capability = await client.refreshCapability();
  if (!capability.available) return unavailable();

  const broker = createScopeRuntimeBroker({
    homePath: options.homePath,
    ...(options.fundedCredentialProvider ? { fundedCredentialProvider: options.fundedCredentialProvider } : {}),
    ...(options.fundedAdmission ? { fundedAdmission: options.fundedAdmission } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    async authorize(request) {
      if (closed) return { allowed: false };
      const owners = [...authorizers.values()].filter((authorizer) => authorizer.owns(request));
      if (owners.length !== 1) return { allowed: false };
      return owners[0]!.authorize(request);
    },
  });
  const server = createScopeRuntimeBrokerServer({
    socketPath: options.brokerSocket ?? BROKER_SOCKET,
    broker,
    routeFrame(raw) {
      if (closed) return undefined;
      const frame = FrameOwnerSchema.safeParse(raw);
      if (!frame.success) return undefined;
      const owners = [...authorizers.values()].filter((authorizer) => authorizer.owns(frame.data));
      const owner = owners.length === 1 ? owners[0] : undefined;
      return owner?.handleFrame ? owner.handleFrame(raw) : undefined;
    },
  });
  try {
    await server.start();
  } catch (error: unknown) {
    console.warn("[scope-runtime-host] broker unavailable:", error instanceof Error ? error.name : "UnknownError");
    await server.close();
    return unavailable();
  }

  return {
    client,
    available: true,
    registerAuthorizer(authorizer) {
      if (closed) throw new ScopeRuntimeHostError("closed");
      if (!AUTHORIZER_ID.test(authorizer.id)) throw new ScopeRuntimeHostError("invalid_authorizer");
      if (!authorizers.has(authorizer.id) && authorizers.size >= MAX_AUTHORIZERS) {
        throw new ScopeRuntimeHostError("capacity_exceeded");
      }
      authorizers.set(authorizer.id, authorizer);
      return () => {
        if (authorizers.get(authorizer.id) === authorizer) authorizers.delete(authorizer.id);
      };
    },
    /** Stops new frames first, then drops registrations, then the supervisor connection. */
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
      authorizers.clear();
      await client.close();
    },
  };
}
