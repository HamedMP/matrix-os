/**
 * Loading the owner's voice for a draft: the profile for the recipient when
 * there are enough sent messages to them, else the overall profile from the
 * Sent folder, else a neutral default. Mailbox failures degrade to the next
 * level; drafting never fails because the voice could not be learned.
 */
import {
  findFolder,
  normalizeMailAddress,
  sameMailAddress,
  type MailAccount,
  type MailFolder,
  type MailMessage,
  type MailProvider,
} from "../../../_shared/office-accounts/types/mail";
import { defaultAgentLogger, type AgentLogger } from "./errors";
import { VOICE_SAMPLE_OVERALL_THREADS, VOICE_SAMPLE_PER_RECIPIENT } from "./limits";
import type { VoiceProfileCache } from "./voice-cache";
import { deriveVoiceProfile, type VoiceProfile } from "./voice-derive";

/** Fewer recipient samples than this fall back to the overall voice. */
export const MIN_RECIPIENT_SAMPLES = 2;

export interface LoadVoiceOptions {
  account: MailAccount;
  provider: MailProvider;
  /** The main recipient, or null for the overall voice. */
  recipient: string | null;
  /** The account's folders, to find Sent for the overall sample. */
  folders: readonly MailFolder[];
  cache: VoiceProfileCache;
  now?: () => number;
  logger?: AgentLogger;
}

async function overallSample(options: LoadVoiceOptions): Promise<MailMessage[]> {
  const sent = findFolder(options.folders, "sent");
  if (!sent) return [];
  const page = await options.provider.listThreads({ folderId: sent.id, limit: VOICE_SAMPLE_OVERALL_THREADS });
  const threads = await Promise.allSettled(page.items.slice(0, VOICE_SAMPLE_OVERALL_THREADS).map((item) => options.provider.getThread(item.id)));
  const messages: MailMessage[] = [];
  for (const result of threads) {
    if (result.status !== "fulfilled") continue;
    const own = result.value.messages.filter((message) => !message.draftId && sameMailAddress(message.from.address, options.account.address));
    const last = own[own.length - 1];
    if (last) messages.push(last);
  }
  return messages;
}

async function overallProfile(options: LoadVoiceOptions, now: number, log: AgentLogger): Promise<VoiceProfile> {
  const cached = await options.cache.get(options.account.id, null);
  if (cached) return cached;
  let messages: MailMessage[] = [];
  try {
    messages = await overallSample(options);
  } catch (error: unknown) {
    log("voice.overall.failed", error);
  }
  const profile = deriveVoiceProfile(messages, { recipient: null, now, ownerAddress: options.account.address });
  if (profile.sampleCount > 0) await options.cache.set(options.account.id, null, profile);
  return profile;
}

export async function loadVoiceProfile(options: LoadVoiceOptions): Promise<VoiceProfile> {
  const now = (options.now ?? (() => Date.now()))();
  const log = options.logger ?? defaultAgentLogger;
  const recipient = options.recipient ? normalizeMailAddress(options.recipient) : null;
  if (recipient && !sameMailAddress(recipient, options.account.address)) {
    const cached = await options.cache.get(options.account.id, recipient);
    if (cached) return cached;
    try {
      const messages = await options.provider.listSentTo(recipient, VOICE_SAMPLE_PER_RECIPIENT);
      const profile = deriveVoiceProfile(messages, { recipient, now, ownerAddress: options.account.address });
      if (profile.sampleCount >= MIN_RECIPIENT_SAMPLES) {
        await options.cache.set(options.account.id, recipient, profile);
        return profile;
      }
    } catch (error: unknown) {
      log("voice.recipient.failed", error);
    }
  }
  return overallProfile(options, now, log);
}
