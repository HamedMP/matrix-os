import { AoedeRequestError } from "./client.js";
import type { CanonicalChatModelSelection, CanonicalCreateChatTurnRequest, CanonicalProviderCatalog } from '@matrix-os/contracts';

interface TextContext { generation: number; chatId: string; revision: number; selection: CanonicalChatModelSelection | undefined; running?: boolean }
/** One bounded, idempotent attempt per owner. Text uses the existing Chat route;
 * the voice capability/funding policy never authorizes a typed kernel task.
 */
export function createAoedeTextSender(deps: {
  context(): TextContext | null;
  catalog(): Promise<CanonicalProviderCatalog | null>;
  prepare?(): Promise<boolean>;
  createTurn(chatId: string, input: CanonicalCreateChatTurnRequest): Promise<unknown>;
  refresh(): Promise<void>;
  fail(error: unknown): void;
}) {
  let busy = false;
  let attempt: { context: TextContext; input: CanonicalCreateChatTurnRequest; text: string } | null = null;
  return async (value: string): Promise<boolean> => {
    const text = value.trim();
    const opening = deps.context();
    if (!opening || !opening.selection || opening.running || busy || !text || text.length > 8000) return false;
    let context: TextContext = opening;
    if (attempt && (attempt.context.generation !== context.generation || attempt.context.chatId !== context.chatId)) attempt = null;
    // An unknown outcome must be retried exactly; never reuse its id for edited text.
    if (attempt && attempt.text !== text) return false;
    busy = true;
    const current = () => { const live = deps.context(); return live?.generation === context.generation && live.chatId === context.chatId; };
    try {
      const initial = context;
      if (deps.prepare && !await deps.prepare()) return false;
      const prepared = deps.context();
      if (!prepared || !prepared.selection || prepared.running || prepared.generation !== initial.generation || prepared.chatId !== initial.chatId) return false;
      context = prepared;
      if (!attempt) {
        const selection = context.selection;
        if (!selection) return false;
        const catalog = await deps.catalog();
        if (!current()) return false;
        const instance = catalog?.instances.find(i => i.id === selection.instanceId && i.availability === 'available');
        const model = instance?.models.find(m => m.id === selection.model && m.availability === 'available');
        // A new widget must never silently choose a harness or full-access permission.
        if (!model || !instance?.supports.interactionModes.includes('default') || !instance.supports.permissionModes.includes('supervised')) return false;
        attempt = { context, text, input: { clientRequestId: `req_${crypto.randomUUID()}`, baseRevision: context.revision, parts: [{ type: 'text', text }], selection, interactionMode: 'default', permissionMode: 'supervised' } };
      }
      await deps.createTurn(context.chatId, attempt.input);
      if (!current()) return false;
      attempt = null;
      // Admission succeeded: a failed refresh must not make the user resend it.
      try { await deps.refresh(); } catch (error: unknown) { if (current()) deps.fail(error); }
      return current();
    } catch (error: unknown) {
      if (current()) {
        if (error instanceof AoedeRequestError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          attempt = null;
          if (error.status === 409) { try { await deps.refresh(); } catch (refreshError: unknown) { deps.fail(refreshError); } }
        }
        deps.fail(error);
      }
      return false;
    } finally { busy = false; }
  };
}
