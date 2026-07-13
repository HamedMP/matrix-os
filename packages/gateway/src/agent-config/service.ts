import {
  AgentSettingsViewSchema,
  type AgentMessagingSelection,
  type AgentProviderDescriptor,
  type AgentRuntimeSelection,
  type AgentSettingsView,
} from "@matrix-os/contracts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  KERNEL_DEFAULTS,
  KERNEL_EFFORTS,
  KERNEL_MODELS,
  normalizeKernelEffort,
  normalizeKernelModel,
} from "../kernel-settings.js";

interface BuildAgentSettingsViewInput {
  identity: Record<string, unknown>;
  config: Record<string, unknown>;
  claudeLoginAvailable: boolean;
  platformCredentialAvailable: boolean;
  runtimeSnapshot?: AgentRuntimeSettingsSnapshot;
}

export interface AgentRuntimeSettingsSnapshot {
  runtime: AgentRuntimeSelection;
  providers: AgentProviderDescriptor[];
  messaging: AgentMessagingSelection;
}

export interface AgentRuntimeSource {
  (signal: AbortSignal): Promise<AgentRuntimeSettingsSnapshot>;
  invalidate?: () => void;
}

export async function readRuntimeSnapshot(
  source: AgentRuntimeSource,
  timeoutMs = 2_000,
): Promise<AgentRuntimeSettingsSnapshot> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Runtime settings probe timed out"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([source(controller.signal), timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

const ClaudeLoginSchema = z.object({
  oauthAccount: z.object({
    accountUuid: z.string().min(1).max(256),
  }).passthrough(),
}).passthrough();

export async function hasClaudeLogin(homePath: string): Promise<boolean> {
  try {
    const raw = await readFile(join(homePath, ".claude.json"), "utf-8");
    return ClaudeLoginSchema.safeParse(JSON.parse(raw)).success;
  } catch (err) {
    if (!(err instanceof Error)
      || (err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        "[agent-config] Failed to read owner login status:",
        err instanceof Error ? err.name : "UnknownError",
      );
    }
    return false;
  }
}

export function buildAgentSettingsView(
  input: BuildAgentSettingsViewInput,
): AgentSettingsView {
  const kernelConfig = typeof input.config.kernel === "object"
    && input.config.kernel !== null
    && !Array.isArray(input.config.kernel)
    ? input.config.kernel as Record<string, unknown>
    : {};
  const savedModel = normalizeKernelModel(kernelConfig.model);
  const savedEffort = normalizeKernelEffort(kernelConfig.effort);
  const hasByokCredential = typeof kernelConfig.anthropicApiKey === "string"
    && kernelConfig.anthropicApiKey.trim().length > 0;
  const authKind = hasByokCredential
    ? "api_key" as const
    : input.claudeLoginAvailable
      ? "oauth_login" as const
      : "platform" as const;
  const model = savedModel ?? KERNEL_DEFAULTS.model;
  const effort = savedEffort ?? KERNEL_DEFAULTS.effort;
  const chat = {
    provider: "anthropic",
    model,
    effort,
    source: savedModel === null ? "default" as const : "saved" as const,
    authKind,
  };
  const authStatus = hasByokCredential
    || input.claudeLoginAvailable
    || input.platformCredentialAvailable
    ? { state: "ready" as const, authenticated: true, action: "none" as const }
    : {
        state: "action_required" as const,
        authenticated: false,
        action: "contact_owner" as const,
      };
  const agentConfig = typeof input.config.agent === "object"
    && input.config.agent !== null
    && !Array.isArray(input.config.agent)
    ? input.config.agent as Record<string, unknown>
    : {};
  const revision = typeof agentConfig.revision === "number"
    && Number.isSafeInteger(agentConfig.revision)
    && agentConfig.revision >= 0
    ? agentConfig.revision
    : 0;

  return AgentSettingsViewSchema.parse({
    identity: input.identity,
    kernel: { model: savedModel, effort: savedEffort },
    availableModels: KERNEL_MODELS,
    availableEfforts: KERNEL_EFFORTS,
    defaults: KERNEL_DEFAULTS,
    contractVersion: 2,
    revision,
    chat,
    runtime: input.runtimeSnapshot?.runtime ?? {
      selected: "hermes",
      options: [
        {
          id: "hermes",
          displayName: "Hermes",
          installState: "unknown",
          health: "unknown",
          selectionState: "active",
          configured: false,
          capabilities: [
            "provider_catalog",
            "model_selection",
            "authentication",
            "messaging_dashboard",
          ],
        },
        {
          id: "openclaw",
          displayName: "OpenClaw",
          installState: "missing",
          health: "stopped",
          selectionState: "unavailable",
          configured: false,
          capabilities: ["install"],
          setupAction: "install",
        },
      ],
      transition: null,
    },
    providers: [{
      id: "anthropic",
      displayName: "Anthropic",
      runtime: null,
      scopes: ["chat"],
      authKind,
      supportedAuthKinds: ["platform", "api_key", "oauth_login"],
      models: KERNEL_MODELS.map((entry) => ({
        id: entry.id,
        displayName: entry.label,
        description: entry.tier,
        capabilities: ["tools", "vision", "reasoning"],
        efforts: [...KERNEL_EFFORTS],
        available: true,
      })),
      authStatus,
    }, ...(input.runtimeSnapshot?.providers ?? [])],
    currentSelection: {
      chat,
      messaging: input.runtimeSnapshot?.messaging ?? {
        runtime: "hermes",
        provider: null,
        model: null,
        configured: false,
      },
    },
  });
}
