/**
 * S09 / T046: the focused shared Codex adapter.
 *
 * Extends the isolated Codex execution from #1761 behind the canonical
 * provider contract: the immutable `codex` harness binding, the pinned
 * harness version from the signed eligibility, execution-root support through
 * the S07 sandbox manifest (the root is bind-mounted at the sandbox workspace),
 * runtime binding for lease-loss revocation, and loss-reason reporting when
 * the home loses the run. The owner's private Codex session is never resumed:
 * every shared run is a fresh isolated turn.
 */
import type { ScopeRuntimeSandboxManifest } from "@matrix-os/scope-runtime";
import type { CollaborationRunInterruptionReason } from "@matrix-os/contracts";
import type { CanonicalChatProviderAdapter } from "../chat/provider-adapter.js";
import {
  createScopeRuntimeChatProviderAdapter,
  type ScopeRuntimeChatClient,
  type SharedRuntimeBindingRegistry,
} from "./scope-runtime-chat-adapter.js";

export interface SharedCodingAdapterOptions {
  client: ScopeRuntimeChatClient;
  scopeId: string;
  executionGeneration: string;
  harnessVersion: string;
  sandbox?: ScopeRuntimeSandboxManifest;
  runtimes?: SharedRuntimeBindingRegistry;
  onLoss?(reason: CollaborationRunInterruptionReason): void;
}

export function createSharedCodexAdapter(options: SharedCodingAdapterOptions): CanonicalChatProviderAdapter {
  return createScopeRuntimeChatProviderAdapter({ ...options, adapterId: "codex" }) as CanonicalChatProviderAdapter;
}
