import type { BotToolRequest, BotToolResult } from '@matrix-os/contracts';
import type { NativeProviderProfileGuard } from '../ai-providers/native-provider-profile-guard.js';
import type { BotRuntimeRegistry, PiRuntimeBinding } from './runtime-registry.js';
import { isManagedPiBinding } from './runtime-registry.js';
import { BotBrokerActionError } from './broker-actions.js';
import type { BotProviderConnectionsService } from './provider-connections.js';
import { runClaudeBotTask } from './claude-task-executor.js';
import { openClaudeBotBridge } from './claude-task-bridge.js';
import { claudeBotCommand } from './claude-task-observation.js';
/** The task executor owns native lifetime; an aborted broker acknowledgement cannot release its profile lease. */
export function createNativeBotTasks(deps: {
  homePath: string; connections: Pick<BotProviderConnectionsService, 'admit' | 'saveSession'>; registry: Pick<BotRuntimeRegistry, 'lookupRun'>;
  profileGuard: Pick<NativeProviderProfileGuard, 'acquire'>; lifetime: AbortSignal;
  runTask?: typeof runClaudeBotTask;
  callTool(binding: PiRuntimeBinding, request: BotToolRequest, signal: AbortSignal): Promise<BotToolResult>;
}) {
  const active = new Map<string, { controller: AbortController; work: Promise<BotToolResult> }>(); // cap4, released only after drain
  const current = async (binding: PiRuntimeBinding) => {
    if (isManagedPiBinding(binding) || !deps.registry.lookupRun(binding) || deps.lifetime.aborted) throw new BotBrokerActionError('not_granted');
    try { return await deps.connections.admit(binding.ownerId, binding.botId, binding.requestClass); }
    catch (error) { console.warn('[bot-native] Admission refused:', error instanceof Error ? error.name : 'UnknownError'); throw new BotBrokerActionError('not_granted'); }
  };
  const service = {
    async prepare(binding: PiRuntimeBinding) { await current(binding); },
    async execute(binding: PiRuntimeBinding, prompt: string, cwd: string, signal: AbortSignal): Promise<BotToolResult> {
      if (isManagedPiBinding(binding) || active.has(binding.botId) || active.size >= 4) throw new BotBrokerActionError('not_granted');
      const controller = new AbortController();
      const lifecycle = AbortSignal.any([signal, controller.signal, deps.lifetime, AbortSignal.timeout(120000)]);
      const work = (async () => {
        let release: (() => void | Promise<void>) | undefined;
        try { release = await deps.profileGuard.acquire('claude', { kind: 'write', durable: true }); }
        catch (error) { console.warn('[bot-native] Profile unavailable:', error instanceof Error ? error.name : 'UnknownError'); throw new BotBrokerActionError('not_granted'); }
        let bridge: Awaited<ReturnType<typeof openClaudeBotBridge>> | undefined; let timer: ReturnType<typeof setInterval> | undefined;
        try {
          const admitted = await current(binding); lifecycle.throwIfAborted();
          const revalidate = async () => {
            lifecycle.throwIfAborted(); const live = await current(binding);
            if (live.revision !== admitted.revision || live.grantRevision !== admitted.grantRevision || live.model !== admitted.model) throw new Error('Task authority changed');
          };
          let checking = false;
          timer = setInterval(() => {
            if (checking) return; checking = true;
            revalidate().catch(error => { console.warn('[bot-native] Task revoked:', error instanceof Error ? error.name : 'UnknownError'); controller.abort(); }).finally(() => { checking = false; });
          }, 2000); timer.unref();
          bridge = await openClaudeBotBridge({ signal: lifecycle, capabilities: binding.capabilities, authorize: revalidate,
            call: tool => deps.callTool(binding, tool, lifecycle) });
          await revalidate();
          const result = await (deps.runTask ?? runClaudeBotTask)({ command: claudeBotCommand(), homePath: deps.homePath, cwd, model: admitted.model,
            prompt, signal: lifecycle, mcpUrl: bridge.url, mcpToken: bridge.token, ...(admitted.sessionId ? { sessionId: admitted.sessionId } : {}) });
          await revalidate();
          await deps.connections.saveSession(binding.ownerId, binding.botId, admitted.revision, result.sessionId);
          return { ok: true as const, content: [{ type: 'text' as const, text: `Claude Code task result (separate native session):\n${result.text}` }] };
        } finally {
          if (timer) clearInterval(timer);
          controller.abort();
          try { await bridge?.close(); } finally { await release(); }
        }
      })();
      active.set(binding.botId, { controller, work });
      try { return await work; } finally { active.delete(binding.botId); }
    },
    async close() { for (const entry of active.values()) entry.controller.abort(); await Promise.allSettled([...active.values()].map(entry => entry.work)); },
  };
  return service;
}
