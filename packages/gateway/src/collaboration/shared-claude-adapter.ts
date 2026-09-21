/**
 * S09 / T046: the focused shared Claude adapter.
 *
 * Extends the isolated Claude execution behind the canonical provider
 * contract with the same execution-root sandboxing, runtime binding and
 * loss reporting as the Codex adapter, preserving the immutable
 * `claude_code` harness binding and the pinned eligibility from #1765. The
 * owner's private Claude session is never resumed for a shared run.
 */
import type { CanonicalChatProviderAdapter } from "../chat/provider-adapter.js";
import { createScopeRuntimeChatProviderAdapter } from "./scope-runtime-chat-adapter.js";
import type { SharedCodingAdapterOptions } from "./shared-codex-adapter.js";

export function createSharedClaudeAdapter(options: SharedCodingAdapterOptions): CanonicalChatProviderAdapter {
  return createScopeRuntimeChatProviderAdapter({ ...options, adapterId: "claude-code" }) as CanonicalChatProviderAdapter;
}
