/**
 * What every Mail agent feature needs: the model, the Mail store, the
 * provider per account, the voice cache and the proposal registry.
 */
import type { MailAccount, MailProvider, MailThread } from "../../../_shared/office-accounts/types/mail";
import type { MailStore, ThreadKey } from "../model";
import type { MailAi } from "./ai";
import { MailAgentError, defaultAgentLogger, toMailAgentError, type AgentLogger } from "./errors";
import { createProposalRegistry, type ProposalRegistry } from "./proposals";
import { createVoiceProfileCache, type VoiceCacheDb, type VoiceProfileCache } from "./voice-cache";

export interface MailAgentContext {
  ai: MailAi;
  store: MailStore;
  /** The adapter the app built for this account (the same one the store uses). */
  providerFor(accountId: string): MailProvider | undefined;
  voiceCache: VoiceProfileCache;
  proposals: ProposalRegistry;
  now(): number;
  log: AgentLogger;
}

export interface MailAgentContextOptions {
  ai: MailAi;
  store: MailStore;
  providerFor(accountId: string): MailProvider | undefined;
  /** Defaults to `window.MatrixOS.db` when present. */
  db?: VoiceCacheDb;
  voiceCache?: VoiceProfileCache;
  proposals?: ProposalRegistry;
  now?: () => number;
  logger?: AgentLogger;
}

function bridgeDb(): VoiceCacheDb | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { MatrixOS?: { db?: VoiceCacheDb } }).MatrixOS?.db;
}

export function createMailAgentContext(options: MailAgentContextOptions): MailAgentContext {
  const now = options.now ?? (() => Date.now());
  const log = options.logger ?? defaultAgentLogger;
  return {
    ai: options.ai,
    store: options.store,
    providerFor: options.providerFor,
    voiceCache: options.voiceCache ?? createVoiceProfileCache(options.db ?? bridgeDb(), { now, logger: log }),
    proposals: options.proposals ?? createProposalRegistry(),
    now,
    log,
  };
}

export function accountOf(ctx: MailAgentContext, accountId: string): MailAccount | undefined {
  return ctx.store.getSnapshot().accounts.find((entry) => entry.account.id === accountId)?.account;
}

/** The account and provider for an id, or `no_account`. */
export function requireAccount(ctx: MailAgentContext, accountId: string | undefined): { account: MailAccount; provider: MailProvider } {
  const account = accountId ? accountOf(ctx, accountId) : ctx.store.getSnapshot().accounts[0]?.account;
  const provider = account ? ctx.providerFor(account.id) : undefined;
  if (!account || !provider) throw new MailAgentError("no_account");
  return { account, provider };
}

/** The full thread for a key: the open one when it matches, else from the provider. */
export async function loadThread(ctx: MailAgentContext, key: ThreadKey): Promise<{ thread: MailThread; account: MailAccount; provider: MailProvider }> {
  const state = ctx.store.getSnapshot();
  const summary = state.threads[key];
  if (!summary) throw new MailAgentError("no_thread");
  const { account, provider } = requireAccount(ctx, summary.accountId);
  if (state.openThread?.key === key && state.openThread.thread) return { thread: state.openThread.thread, account, provider };
  try {
    return { thread: await provider.getThread(summary.id), account, provider };
  } catch (error: unknown) {
    ctx.log("agent.thread.failed", error);
    throw toMailAgentError(error);
  }
}
