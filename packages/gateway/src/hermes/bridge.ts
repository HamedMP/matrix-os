import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  redactLabel,
  safeMessage,
  type ApprovalDecisionInput,
  type ApprovalPrompt,
  type CreateSessionInput,
  type GatewayActionInput,
  type HermesCapability,
  type HermesConfigInput,
  type HermesInstallation,
  type HermesSession,
  type MessagingChannel,
  type ModelCredentialInput,
  type ChannelActionInput,
  type ModelProviderConnection,
  type SendPromptInput,
} from "./contracts.js";

const execFileAsync = promisify(execFile);
const MAX_ACTIVE_HERMES_PATHS = 200;
const SAFE_HERMES_PATH_LABEL = /^[A-Za-z0-9._=-]{1,80}$/;

export type HermesBridgeErrorCode = "unavailable" | "timeout" | "invalid_request" | "invalid_upstream_response" | "operation_failed" | "conflict" | "unauthorized" | "not_found";

export class HermesBridgeError extends Error {
  constructor(readonly code: HermesBridgeErrorCode, message = "Hermes bridge failed") {
    super(message);
    this.name = "HermesBridgeError";
  }
}

export interface OwnerContext {
  ownerId: string;
  installation: HermesInstallation | null;
}

export interface HermesConfigBridgeResult {
  patch: Partial<HermesInstallation>;
  // Routes call activate only after the repository write commits, so a failed config save leaves the active bridge path unchanged.
  activate(): void;
}

export interface ChannelActionBridgeResult {
  channel: MessagingChannel;
  pairing?: {
    kind: "qr" | "code";
    displayValue: string;
    expiresAt: string;
  };
}

export interface HermesBridge {
  getStatus(input: OwnerContext): Promise<Partial<HermesInstallation>>;
  saveConfig(input: OwnerContext & { config: HermesConfigInput }): Promise<HermesConfigBridgeResult>;
  saveModelCredential(input: OwnerContext & { credential: ModelCredentialInput }): Promise<ModelProviderConnection>;
  listChannels(input: OwnerContext): Promise<MessagingChannel[]>;
  runChannelAction(input: OwnerContext & { channelId: "telegram" | "whatsapp"; action: ChannelActionInput }): Promise<ChannelActionBridgeResult>;
  listCapabilities(input: OwnerContext): Promise<HermesCapability[]>;
  runGatewayAction(input: OwnerContext & { action: GatewayActionInput }): Promise<{ id: string; status: "running" | "complete"; message: string; patch?: Partial<HermesInstallation> }>;
  createSession(input: OwnerContext & { operatorId: string; payload: CreateSessionInput }): Promise<HermesSession>;
  sendPrompt(input: OwnerContext & { operatorId: string; session: HermesSession; payload: SendPromptInput }): Promise<HermesSession>;
  decideApproval(input: OwnerContext & { operatorId: string; approval: ApprovalPrompt; payload: ApprovalDecisionInput }): Promise<ApprovalPrompt>;
  recover(input: OwnerContext & { targetId?: string }): Promise<{ status: "complete"; message: string }>;
}

export interface LocalHermesBridgeOptions {
  hermesPath?: string;
  homePath: string;
  timeoutMs?: number;
}

function timestamp(): string {
  return new Date().toISOString();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return false;
    console.warn("[hermes] Path check failed:", err instanceof Error ? err.message : String(err));
    throw new HermesBridgeError("operation_failed");
  }
}

async function realpathOrResolved(path: string): Promise<string> {
  const resolved = resolve(path);
  return await realpath(resolved).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") throw new HermesBridgeError("invalid_request");
    throw err;
  });
}

async function restorableRoot(path: string): Promise<string> {
  return await realpathOrResolved(path).catch((err: unknown) => {
    if (err instanceof HermesBridgeError && err.code === "invalid_request") return resolve(path);
    throw err;
  });
}

async function resolveAllowedHermesPath(inputPath: string, allowedRoots: string[]): Promise<string> {
  const realCandidate = await realpathOrResolved(inputPath);
  const allowed = await Promise.all(allowedRoots.map(async (root) => await realpathOrResolved(root).catch((err: unknown) => {
    if (err instanceof HermesBridgeError && err.code === "invalid_request") return resolve(root);
    throw err;
  })));
  const insideAllowedRoot = allowed.some((root) => {
    const rel = relative(root, realCandidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!insideAllowedRoot || !await pathExists(join(realCandidate, "cli.py"))) throw new HermesBridgeError("invalid_request");
  return realCandidate;
}

function defaultChannels(): MessagingChannel[] {
  const now = timestamp();
  return [
    { id: "telegram", platform: "telegram", enabled: false, configured: false, status: "disconnected", allowedSenderPolicy: "Not configured", lastCheckedAt: null, updatedAt: now },
    { id: "whatsapp", platform: "whatsapp", enabled: false, configured: false, status: "disconnected", allowedSenderPolicy: "Not configured", lastCheckedAt: null, updatedAt: now },
  ];
}

function isExecTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const execError = err as Error & { code?: unknown; killed?: unknown };
  return execError.killed === true || execError.code === "ETIMEDOUT" || err.message.includes("timed out");
}

export function createLocalHermesBridge(options: LocalHermesBridgeOptions): HermesBridge {
  const defaultHermesPath = options.hermesPath ?? process.env.HERMES_REPO_PATH ?? "/home/deploy/hermes-agent";
  const activeHermesPaths = new Map<string, string>();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const ownerHermesRoot = join(options.homePath, "system", "hermes");
  const allowedHermesRoots = [defaultHermesPath, ownerHermesRoot];

  function getActiveHermesPath(ownerId: string, installation: HermesInstallation | null = null): string {
    const activePath = activeHermesPaths.get(ownerId);
    if (activePath) return activePath;
    if (installation?.homeMode === "custom" && installation.hermesPathLabel && SAFE_HERMES_PATH_LABEL.test(installation.hermesPathLabel)) {
      return join(options.homePath, "system", "hermes", installation.hermesPathLabel);
    }
    return defaultHermesPath;
  }

  async function resolveRestorableHermesPath(inputPath: string): Promise<string> {
    const hermesPath = await resolveAllowedHermesPath(inputPath, allowedHermesRoots);
    const realDefault = await restorableRoot(defaultHermesPath);
    if (hermesPath === realDefault) return hermesPath;
    const realOwnerRoot = await restorableRoot(ownerHermesRoot);
    const relativeOwnerPath = relative(realOwnerRoot, hermesPath);
    const isDirectOwnerChild = relativeOwnerPath
      && !relativeOwnerPath.startsWith("..")
      && !isAbsolute(relativeOwnerPath)
      && !relativeOwnerPath.includes("/")
      && !relativeOwnerPath.includes("\\");
    if (isDirectOwnerChild) return hermesPath;
    throw new HermesBridgeError("invalid_request");
  }

  function rememberActiveHermesPath(ownerId: string, hermesPath: string): void {
    activeHermesPaths.delete(ownerId);
    activeHermesPaths.set(ownerId, hermesPath);
    while (activeHermesPaths.size > MAX_ACTIVE_HERMES_PATHS) {
      const oldestOwnerId = activeHermesPaths.keys().next().value as string | undefined;
      if (!oldestOwnerId) break;
      activeHermesPaths.delete(oldestOwnerId);
    }
  }

  async function runHermes(ownerId: string, installation: HermesInstallation | null, args: string[], timeout = timeoutMs): Promise<string> {
    const hermesPath = getActiveHermesPath(ownerId, installation);
    try {
      const { stdout } = await execFileAsync("python3", [join(hermesPath, "cli.py"), ...args], {
        cwd: hermesPath,
        timeout,
        maxBuffer: 1024 * 1024,
      });
      return stdout;
    } catch (err: unknown) {
      if (isExecTimeout(err)) throw new HermesBridgeError("timeout");
      console.warn("[hermes] CLI bridge failed:", err instanceof Error ? err.message : String(err));
      throw new HermesBridgeError("operation_failed");
    }
  }

  return {
    async getStatus({ ownerId, installation }) {
      const hermesPath = getActiveHermesPath(ownerId, installation);
      const exists = await pathExists(join(hermesPath, "cli.py"));
      if (!exists) {
        return { readiness: "missing", hermesPathLabel: redactLabel(hermesPath), lastCheckedAt: timestamp() };
      }
      let version: string | null = null;
      try {
        const output = await runHermes(ownerId, installation, ["--version"], 5_000);
        version = safeMessage(output.trim(), "installed");
      } catch (err: unknown) {
        console.warn("[hermes] Version detection failed:", err instanceof Error ? err.message : String(err));
        version = null;
      }
      const readinessPatch: Partial<HermesInstallation> = !installation || installation.readiness === "missing" ? { readiness: "installed" } : {};
      return {
        ...readinessPatch,
        hermesPathLabel: redactLabel(hermesPath),
        version,
        lastCheckedAt: timestamp(),
      };
    },

    async saveConfig({ ownerId, config }) {
      const configuredHermesPath = config.homeMode === "custom" && config.hermesPath
        ? await resolveRestorableHermesPath(config.hermesPath)
        : config.homeMode === "default"
          ? defaultHermesPath
          : null;
      const isDefaultHermesPath = configuredHermesPath === defaultHermesPath;
      return {
        patch: {
          homeMode: configuredHermesPath ? (isDefaultHermesPath ? "default" : "custom") : undefined,
          hermesPathLabel: configuredHermesPath ? (isDefaultHermesPath ? null : redactLabel(configuredHermesPath)) : undefined,
          lastCheckedAt: timestamp(),
        },
        activate: () => {
          if (configuredHermesPath) rememberActiveHermesPath(ownerId, configuredHermesPath);
        },
      };
    },

    async saveModelCredential({ credential }) {
      return {
        id: credential.providerId,
        configured: true,
        status: "healthy",
        availableModels: [],
        lastCheckedAt: timestamp(),
      };
    },

    async listChannels() {
      return defaultChannels();
    },

    async runChannelAction({ channelId, action }) {
      const now = timestamp();
      const connected = action.type === "connect" || action.type === "verify" || action.type === "enable" || action.type === "recover";
      const pairing = action.type === "start_pairing";
      const channel: MessagingChannel = {
        id: channelId,
        platform: channelId,
        enabled: action.type !== "disable",
        configured: connected || pairing,
        status: action.type === "disable" ? "disabled" : pairing ? "pairing" : connected ? "connected" : "disconnected",
        allowedSenderPolicy: "Configured",
        lastCheckedAt: now,
        updatedAt: now,
      };
      return {
        channel,
        pairing: pairing
          ? { kind: "code", displayValue: "PAIR-HERMES", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }
          : undefined,
      };
    },

    async listCapabilities() {
      const now = timestamp();
      return [
        { id: "default-profile", kind: "profile", name: "Default profile", enabled: true, status: "available", description: "Default Hermes profile", updatedAt: now },
        { id: "gateway", kind: "gateway", name: "Messaging gateway", enabled: true, status: "available", description: "Hermes messaging gateway", updatedAt: now },
      ];
    },

    async runGatewayAction({ action }) {
      const status = action.type === "restart" ? "running" : "complete";
      const patch: Partial<HermesInstallation> = action.type === "health_check"
        ? { gatewayStatus: "healthy", readiness: "ready", lastCheckedAt: timestamp() }
        : action.type === "update"
          ? { readiness: "updating", lastCheckedAt: timestamp() }
          : { gatewayStatus: "starting", lastCheckedAt: timestamp() };
      return { id: `op_${randomUUID()}`, status, message: "Gateway action accepted", patch };
    },

    async createSession({ ownerId, operatorId, installation, payload }) {
      const now = timestamp();
      return {
        id: `ses_${randomUUID()}`,
        hermesSessionId: `hermes_${randomUUID()}`,
        installationId: installation?.id ?? `hermes_${ownerId}`,
        ownerId,
        operatorId,
        profileId: payload.profileId,
        modelId: payload.modelId,
        status: "streaming",
        eventCount: 1,
        createdAt: now,
        updatedAt: now,
        lastActiveAt: now,
      };
    },

    async sendPrompt({ session }) {
      const now = timestamp();
      return { ...session, status: "streaming", eventCount: session.eventCount + 1, updatedAt: now, lastActiveAt: now };
    },

    async decideApproval({ approval, operatorId, payload }) {
      return {
        ...approval,
        status: payload.decision,
        decisionBy: operatorId,
        decisionAt: timestamp(),
      };
    },

    async recover() {
      return { status: "complete", message: "Recovery completed" };
    },
  };
}
