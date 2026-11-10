import { CollaborativeAppParticipantSchema, CollaborationRevisionSchema, MAX_APP_DATABASE_REQUEST_BYTES } from "@matrix-os/contracts";
import { z } from "zod/v4";

export const NATIVE_APP_COLLABORATION_CHANNEL = "native-app:collaboration";
const ActionSchema = z.object({ action: z.string().min(1).max(64) }).passthrough();
export const NativeAppCollaborationRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("state") }),
  z.strictObject({ kind: z.literal("query"), action: ActionSchema }),
  z.strictObject({ kind: z.literal("mutate"), action: ActionSchema,
    expectedRevision: CollaborationRevisionSchema, clientRequestId: z.uuid() }),
]).refine((request) => {
  try { return new TextEncoder().encode(JSON.stringify(request)).byteLength <= MAX_APP_DATABASE_REQUEST_BYTES; }
  catch { return false; }
});
export const NativeAppCollaborationStateSchema = z.strictObject({
  participant: CollaborativeAppParticipantSchema.nullable(), revision: CollaborationRevisionSchema,
  scopeSequence: CollaborationRevisionSchema,
});
export type NativeAppCollaborationRequest = z.infer<typeof NativeAppCollaborationRequestSchema>;

export function createNativeAppCollaboration(invoke: (request: NativeAppCollaborationRequest) => Promise<unknown>,
  initialParticipant: z.infer<typeof CollaborativeAppParticipantSchema> | null = null) {
  let participant: z.infer<typeof CollaborativeAppParticipantSchema> | null = initialParticipant;
  let revision: string | null = null;
  let scopeSequence: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let pending: NativeAppCollaborationRequest[] = [];
  const callbacks = new Set<() => void>();
  let stateGeneration = 0;
  let appliedGeneration = 0;
  let polling = false;
  const state = async () => {
    const generation = ++stateGeneration;
    const next = NativeAppCollaborationStateSchema.parse(await invoke({ kind: "state" }));
    if (generation < appliedGeneration) return next;
    appliedGeneration = generation;
    const changed = revision !== null && (revision !== next.revision || scopeSequence !== next.scopeSequence || participant?.scopeId !== next.participant?.scopeId
      || participant?.shareRevision !== next.participant?.shareRevision);
    participant = next.participant;
    revision = next.revision;
    scopeSequence = next.scopeSequence;
    if (changed) for (const callback of callbacks) {
      try { callback(); } catch (error: unknown) {
        console.warn("[native-app-collaboration] change callback failed", error instanceof Error ? error.name : "UnknownError");
      }
    }
    return next;
  };
  const execute = async (request: NativeAppCollaborationRequest) => {
    const parsed = NativeAppCollaborationRequestSchema.parse(request);
    return invoke(parsed);
  };
  return {
    // The owner participant is resolved by the trusted main process on each request.
    participant: initialParticipant,
    async refreshParticipant() { return (await state()).participant; },
    async query(action: unknown) {
      await state();
      const parsed = ActionSchema.parse(action);
      return execute({ kind: "query", action: parsed });
    },
    async mutate(action: unknown, expectedRevision: string) {
      const current = await state();
      const parsed = ActionSchema.parse(action);
      const revision = CollaborationRevisionSchema.parse(expectedRevision);
      const request = { kind: "mutate" as const, action: parsed, expectedRevision: revision, clientRequestId: crypto.randomUUID() };
      try { return await execute(request); }
      catch (error: unknown) {
        if (current.participant && pending.length < 32) pending.push(request);
        throw error;
      }
    },
    async retryMutation() {
      if (!pending.length) throw new Error("Collaboration unavailable");
      let response: unknown;
      while (pending.length) {
        response = await execute(pending[0]!);
        pending = pending.slice(1);
      }
      return response;
    },
    onChange(callback: () => void) {
      if (typeof callback !== "function" || callbacks.size >= 32) throw new Error("Collaboration unavailable");
      callbacks.add(callback);
      if (!timer) {
        timer = setInterval(() => {
          if (polling) return;
          polling = true;
          void state().catch((error: unknown) => {
            console.warn("[native-app-collaboration] change check failed", error instanceof Error ? error.name : "UnknownError");
          }).finally(() => { polling = false; });
        }, 2_000);
      }
      return () => { callbacks.delete(callback); if (!callbacks.size && timer) { clearInterval(timer); timer = null; } };
    },
  };
}
