import { z } from 'zod/v4';
import { isWhatsAppSenderAllowed, WhatsAppPhoneSchema, type WhatsAppConfig } from './config.js';
import { canAdmitWhatsAppMessage, isWhatsAppSenderEligible, isWhatsAppReplyWindowOpen, sendWhatsAppText, sendWhatsAppReaction, WhatsAppSendError, type WhatsAppMessage, type WhatsAppProcessingReaction } from './cloud-api.js';
import type { createWhatsAppRepository } from './repository.js';
import { WhatsAppPreparedAdmissionSchema, type WhatsAppAgentClient, type WhatsAppAgentCheckpoint } from './agent-client.js';

const checkpointSchema = z.object({ machineId: z.string().min(1).max(160), chatId: z.string().min(1).max(160), runId: z.string().min(1).max(160) });
const inputSchema = z.object({
  kind: z.literal('incoming'), text: z.string().max(4096).optional(), type: z.string().max(80),
  owner: z.string().max(160).nullable(), connectionId: z.string().max(160).nullable(),
  timestamp: z.number().int().positive(),
  phone: WhatsAppPhoneSchema.optional(),
  preparedAdmission: WhatsAppPreparedAdmissionSchema.optional(),
});
const runSchema = z.object({ kind: z.literal('run'), owner: z.string().max(160), connectionId: z.string().max(160), checkpoint: checkpointSchema, phone: WhatsAppPhoneSchema.optional() });
const replySchema = z.object({ kind: z.literal('reply'), text: z.string().min(1).max(4096), owner: z.string().max(160).optional(), connectionId: z.string().max(160).optional(), phone: WhatsAppPhoneSchema.optional(), reaction: z.enum(['✅', '❌']).optional() });
const verificationSchema = z.object({ kind: z.literal('verification'), text: z.string().min(1).max(4096), owner: z.string().max(160), tokenHash: z.string().regex(/^[a-f0-9]{64}$/), phone: WhatsAppPhoneSchema.optional() });
const payloadSchema = z.discriminatedUnion('kind', [inputSchema, runSchema, replySchema, verificationSchema]);
type Repository = ReturnType<typeof createWhatsAppRepository>;
type Job = NonNullable<Awaited<ReturnType<Repository['lease']>>>;

class WhatsAppCheckpointOutcomeUnknown extends Error {
  constructor(cause: unknown) {
    super('WhatsApp checkpoint outcome is unknown', { cause });
  }
}

export function createWhatsAppService(deps: {
  config: WhatsAppConfig; repository: Repository; agent: WhatsAppAgentClient;
  now?: () => number; send?: (sender: string, text: string) => Promise<string>;
  react?: (sender: string, messageId: string, emoji: WhatsAppProcessingReaction) => Promise<void>;
  logError?: (error: unknown) => void;
}) {
  const { config, repository: repo, agent } = deps;
  const now = deps.now ?? Date.now;
  // Only internally admitted durable jobs reach send. A signed event may pair an
  // allowlisted phone with its BSUID; retain that identity when the phone disappears.
  const send = deps.send ?? ((sender, text) => sendWhatsAppText({ ...config, allowedSenders: [...config.allowedSenders, sender] }, sender, text));
  const react = deps.react ?? (async (sender, messageId, emoji) => {
    await sendWhatsAppReaction({ ...config, allowedSenders: [...config.allowedSenders, sender] }, sender, messageId, emoji);
  });
  const log = deps.logError ?? ((error) => console.error('[whatsapp] Delivery failed', error));
  let stopped = false;
  let active: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCleanup = 0;

  async function ingest(messages: WhatsAppMessage[]): Promise<void> {
    for (const message of messages) {
      if (message.type === 'reaction') continue;
      const connection = await repo.getConnectionBySender(message.sender);
      const admitted = canAdmitWhatsAppMessage(config, message, now()) || (message.sender.includes('.') && connection !== null
        && isWhatsAppSenderEligible(message.sender) && isWhatsAppReplyWindowOpen(message.timestamp, now()));
      if (!admitted) continue;
      // Only signed, explicitly allowlisted phone/account pairs may route replies.
      const phone = message.phone && isWhatsAppSenderAllowed(config, message.phone) ? message.phone : undefined;
      const expiresAt = Math.min(now() + 86_400_000, message.timestamp * 1000 + 86_400_000);
      if (message.text?.trim().toUpperCase() === 'STOP' || message.text?.trim().toLowerCase() === '/disconnect') {
        await repo.stop(message.sender, message.id, expiresAt, message.timestamp * 1000, ...(phone ? [phone] : []));
        continue;
      }
      // Snapshot association at admission: linking later must not execute an old greeting.
      await repo.enqueue({ id: message.id, sender: message.sender,
        payload: { kind: 'incoming', text: message.text, type: message.type, timestamp: message.timestamp,
          owner: connection?.owner ?? null, connectionId: connection?.id ?? null, ...(phone ? { phone } : {}) },
        expiresAt,
      });
    }
  }

  async function associationValid(sender: string, owner: string, id: string): Promise<boolean> {
    const current = await repo.getConnectionBySender(sender);
    return current?.owner === owner && current.id === id && current.consentVersion === 'whatsapp-general-agent-v1';
  }

  async function processingReaction(job: Job, emoji: WhatsAppProcessingReaction): Promise<void> {
    // Cosmetic feedback must never fail a turn, replay a text response, or use
    // an association that was revoked while the agent was working.
    try {
      const { owner, connectionId, phone } = job.payload;
      if (job.expiresAt <= now() || typeof owner !== 'string' || typeof connectionId !== 'string'
        || (typeof phone === 'string' && !isWhatsAppSenderAllowed(config, phone))
        || !await associationValid(job.sender, owner, connectionId)) return;
      await react(typeof phone === 'string' ? phone : job.sender, job.id, emoji);
    } catch (error) { log(error); }
  }

  async function saveCheckpoint(job: Job, payload: Record<string, unknown>): Promise<boolean> {
    let saved: boolean;
    try { saved = await repo.checkpoint(job.id, job.fence, payload); }
    catch (error) { throw new WhatsAppCheckpointOutcomeUnknown(error); }
    // Error recovery must use the last confirmed progress, never the original
    // leased input after it has already advanced to a run or prepared reply.
    if (saved) job.payload = payload;
    return saved;
  }

  async function deliver(job: Job, payload: z.infer<typeof replySchema> | z.infer<typeof verificationSchema>) {
    if (payload.phone && !isWhatsAppSenderAllowed(config, payload.phone)) {
      await repo.finish(job.id, job.fence, 'failed'); return;
    }
    if (payload.kind === 'verification' && !await repo.isChallengeActive(payload.tokenHash, payload.owner)) {
      await repo.finish(job.id, job.fence, 'failed'); return;
    }
    if (payload.kind === 'reply' && payload.owner && payload.connectionId
      && !await associationValid(job.sender, payload.owner, payload.connectionId)) {
      await repo.finish(job.id, job.fence, 'failed'); return;
    }
    // Record uncertainty BEFORE the external side effect. Expired sends are never replayed.
    if (!await repo.markSending(job.id, job.fence)) return;
    try {
      await send(payload.phone ?? job.sender, payload.text);
      const finished = await repo.finish(job.id, job.fence, 'complete');
      if (finished && payload.kind === 'reply' && payload.reaction) await processingReaction(job, payload.reaction);
    } catch (error) {
      log(error);
      await repo.finish(job.id, job.fence, error instanceof WhatsAppSendError && !error.ambiguous ? 'failed' : 'unknown');
    }
  }

  async function reply(job: Job, text: string, owner?: string, connectionId?: string, reaction?: '✅' | '❌') {
    const payload = { kind: 'reply' as const, text, ...(owner ? { owner, connectionId } : {}),
      ...(reaction ? { reaction } : {}),
      ...(typeof job.payload.phone === 'string' ? { phone: job.payload.phone } : {}) };
    if (await saveCheckpoint(job, payload)) await deliver(job, payload);
  }

  async function process(job: Job): Promise<void> {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success || job.expiresAt <= now()) { await repo.finish(job.id, job.fence, 'failed'); return; }
    const payload = parsed.data;
    if (payload.kind === 'reply' || payload.kind === 'verification') { await deliver(job, payload); return; }
    if (payload.kind === 'run') {
      if (!await associationValid(job.sender, payload.owner, payload.connectionId)) { await repo.finish(job.id, job.fence, 'failed'); return; }
      const result = await agent.poll(payload.owner, payload.checkpoint as WhatsAppAgentCheckpoint);
      if (result.state === 'pending') {
        if (await saveCheckpoint(job, { ...job.payload, failures: 0 })) await repo.retry(job.id, job.fence, 2000);
        return;
      }
      const text = result.state === 'attention'
        ? `Your Matrix agent needs your attention. Open Matrix to continue: ${config.publicUrl}`
        : (result.state === 'complete' && result.text || 'Your Matrix agent finished. Open Matrix to view the Chat.');
      await reply(job, text.includes('Open Matrix') ? `${text}\n${config.publicUrl}`.slice(0, 4096) : text, payload.owner, payload.connectionId, result.state === 'complete' ? '✅' : '❌');
      return;
    }
    if (payload.text?.trim().toUpperCase() === 'STOP' || payload.text?.trim().toLowerCase() === '/disconnect') {
      await repo.stop(job.sender, job.id, job.expiresAt, payload.timestamp * 1000, ...(payload.phone ? [payload.phone] : []));
      return;
    }
    if (payload.type === 'reaction') { await repo.finish(job.id, job.fence, 'complete'); return; }
    if (payload.type !== 'text') { await reply(job, 'Matrix on WhatsApp currently accepts text messages. Send your request as text.'); return; }
    if (payload.text?.trim().toUpperCase() === 'HELP') {
      await reply(job, `Chat with your Matrix agent here. Send STOP to disconnect. For human help, reach our team: https://discord.gg/cSBBQWtPwV`); return;
    }
    if (!payload.owner || !payload.connectionId) {
      const link = await repo.startLink(job.sender, job.id, job.expiresAt, ...(payload.phone ? [payload.phone] : []));
      await reply(job, `Connect your Matrix agent to WhatsApp:\n${config.publicUrl}/whatsapp/connect?token=${encodeURIComponent(link.token)}\n\nSign in, then confirm the code sent here. Send HELP for support or STOP to disconnect.`);
      return;
    }
    if (!await associationValid(job.sender, payload.owner, payload.connectionId)) { await repo.finish(job.id, job.fence, 'failed'); return; }
    if (!await saveCheckpoint(job, job.payload)) return;
    await processingReaction(job, '👀');
    if (job.expiresAt <= now() || !await associationValid(job.sender, payload.owner, payload.connectionId)) { await repo.finish(job.id, job.fence, 'failed'); return; }
    const connection = await repo.getConnection(payload.owner);
    if (!await saveCheckpoint(job, job.payload)) return;
    const checkpoint = await agent.start({ owner: payload.owner, sender: job.sender, messageId: job.id, text: payload.text ?? '',
      ...(payload.preparedAdmission ? { preparedAdmission: payload.preparedAdmission } : {}),
      ...(connection?.chatId ? { chatId: connection.chatId } : {}), ...(connection?.machineId ? { machineId: connection.machineId } : {}), allowFullAccess: true },
      async () => await associationValid(job.sender, payload.owner!, payload.connectionId!)
        && await saveCheckpoint(job, job.payload),
      async (preparedAdmission) => await associationValid(job.sender, payload.owner!, payload.connectionId!)
        && await saveCheckpoint(job, { ...job.payload, preparedAdmission }));
    if (!await associationValid(job.sender, payload.owner, payload.connectionId)) { await repo.finish(job.id, job.fence, 'failed'); return; }
    const binding = [payload.owner, job.sender, checkpoint.machineId, checkpoint.chatId, payload.connectionId] as const;
    if (checkpoint.replacedChatId) await repo.bindChat(...binding, checkpoint.replacedChatId);
    else await repo.bindChat(...binding);
    const storedCheckpoint = { machineId: checkpoint.machineId, chatId: checkpoint.chatId, runId: checkpoint.runId };
    if (await saveCheckpoint(job, { kind: 'run', owner: payload.owner, connectionId: payload.connectionId, checkpoint: storedCheckpoint,
      ...(payload.phone ? { phone: payload.phone } : {}) })) {
      await repo.retry(job.id, job.fence, 0);
    }
  }

  async function work(): Promise<void> {
    if (now() - lastCleanup >= 60_000) { await repo.cleanup(); lastCleanup = now(); }
    const job = await repo.lease();
    if (!job) return;
    try { await process(job); }
    catch (error) {
      log(error);
      // A rejected DB response can follow a committed checkpoint. Leave the
      // lease to expire so the next worker reads persisted progress; writing
      // the stale local payload here could undo that commit or replay work.
      if (error instanceof WhatsAppCheckpointOutcomeUnknown) return;
      const previous = job.payload.failures;
      const failures = (typeof previous === 'number' && Number.isInteger(previous) && previous >= 0 && previous < 5 ? previous : 0) + 1;
      if (failures >= 5) {
        const payload = payloadSchema.safeParse(job.payload);
        if (payload.success && (payload.data.kind === 'incoming' || payload.data.kind === 'run')
          && payload.data.owner && payload.data.connectionId) {
          await reply(job, `Your Matrix agent is temporarily unavailable. Open Matrix to check your agent and try again: ${config.publicUrl}`,
            payload.data.owner, payload.data.connectionId, '❌');
        } else await repo.finish(job.id, job.fence, 'failed');
      }
      else if (await saveCheckpoint(job, { ...job.payload, failures })) await repo.retry(job.id, job.fence, Math.min(30_000, 1000 * 2 ** failures));
    }
  }
  async function tick(): Promise<void> {
    if (stopped) return;
    if (active) return active;
    active = work().catch(log).finally(() => { active = undefined; });
    await active;
  }
  function start() {
    if (stopped || timer) return;
    const schedule = () => {
      timer = setTimeout(() => {
        timer = undefined;
        void tick().finally(() => { if (!stopped) schedule(); });
      }, 1000);
      timer.unref();
    };
    schedule();
  }
  async function shutdown() { stopped = true; if (timer) clearTimeout(timer); timer = undefined; await active; }
  return { ingest, tick, start, shutdown };
}
export type WhatsAppService = ReturnType<typeof createWhatsAppService>;
