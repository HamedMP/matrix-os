import { CollaborativeAppParticipantSchema, CollaborationIdSchema, CollaborationRevisionSchema, CollaborationSafeErrorCodeSchema, MAX_APP_DATABASE_REQUEST_BYTES } from "@matrix-os/contracts";
import { z } from "zod/v4";

export const NATIVE_APP_COLLABORATION_CHANNEL = "native-app:collaboration";
const ActionSchema = z.object({ action: z.string().min(1).max(64) }).passthrough();
export const NativeAppCollaborationRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("state") }),
  z.strictObject({ kind: z.literal("query"), action: ActionSchema }),
  z.strictObject({ kind: z.literal("mutate"), action: ActionSchema,
    expectedRevision: CollaborationRevisionSchema, clientRequestId: z.uuid(), scopeId: CollaborationIdSchema.nullable() }),
]).refine((request) => {
  try { return new TextEncoder().encode(JSON.stringify(request)).byteLength <= MAX_APP_DATABASE_REQUEST_BYTES; }
  catch (error: unknown) {
    console.warn("[native-app-collaboration] request serialization failed", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
});
export const NativeAppCollaborationStateSchema = z.strictObject({
  participant: CollaborativeAppParticipantSchema.nullable(), revision: CollaborationRevisionSchema,
  scopeSequence: CollaborationRevisionSchema,
});
export type NativeAppCollaborationRequest = z.infer<typeof NativeAppCollaborationRequestSchema>;
export class NativeAppCollaborationError extends Error {
  constructor(readonly code: z.infer<typeof CollaborationSafeErrorCodeSchema>) {
    super(`Collaboration ${code}`);
    this.name = "NativeAppCollaborationError";
  }
}
export const NATIVE_COLLABORATION_ERROR_KEY = "__matrixCollaborationError";
const definitelyRejected = (error: unknown) => error instanceof Error && "code" in error
  && ["conflict", "invalid_request", "forbidden", "unauthorized", "not_found", "read_only", "expired"]
    .includes(String(error.code));

export function createNativeAppCollaboration(invoke: (request: NativeAppCollaborationRequest) => Promise<unknown>,
  initialParticipant: z.infer<typeof CollaborativeAppParticipantSchema> | null = null,
  onParticipantChanged?: (participant: z.infer<typeof CollaborativeAppParticipantSchema> | null) => void) {
  let participant: z.infer<typeof CollaborativeAppParticipantSchema> | null = initialParticipant;
  let revision: string | null = null;
  let scopeSequence: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let pending: Array<{ request: Extract<NativeAppCollaborationRequest, { kind: "mutate" }>; inFlight: boolean }> = [];
  const callbacks = new Set<() => void>();
  let stateGeneration = 0;
  let appliedGeneration = 0;
  let polling = false;
  const state = async () => {
    const generation = ++stateGeneration;
    const next = NativeAppCollaborationStateSchema.parse(await invoke({ kind: "state" }));
    if (generation < appliedGeneration) return next;
    appliedGeneration = generation;
    const participantChanged = participant?.scopeId !== next.participant?.scopeId
      || participant?.shareRevision !== next.participant?.shareRevision
      || participant?.buildId !== next.participant?.buildId;
    const changed = revision !== null && (revision !== next.revision || scopeSequence !== next.scopeSequence || participantChanged);
    participant = next.participant;
    revision = next.revision;
    scopeSequence = next.scopeSequence;
    if (participantChanged && onParticipantChanged) {
      try { onParticipantChanged(next.participant); } catch (error: unknown) {
        console.warn("[native-app-collaboration] participant update failed", error instanceof Error ? error.name : "UnknownError");
      }
    }
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
      const request = { kind: "mutate" as const, action: parsed, expectedRevision: revision,
        clientRequestId: crypto.randomUUID(), scopeId: current.participant?.scopeId ?? null };
      if (current.participant && pending.length >= 32) throw new Error("Collaboration unavailable");
      const entry = { request, inFlight: true };
      if (current.participant) pending.push(entry);
      try {
        const result = await execute(request);
        pending = pending.filter((item) => item !== entry);
        return result;
      }
      catch (error: unknown) {
        console.warn("[native-app-collaboration] mutation failed", error instanceof Error ? error.name : "UnknownError");
        entry.inFlight = false;
        if (definitelyRejected(error)) pending = pending.filter((item) => item !== entry);
        throw error;
      }
    },
    async retryMutation() {
      if (!pending.length) throw new Error("Collaboration unavailable");
      let response: unknown;
      let definiteError: unknown;
      for (const entry of [...pending]) {
        if (entry.inFlight || !pending.includes(entry)) continue;
        entry.inFlight = true;
        try {
          response = await execute(entry.request);
          pending = pending.filter((item) => item !== entry);
        } catch (error: unknown) {
          console.warn("[native-app-collaboration] retry failed", error instanceof Error ? error.name : "UnknownError");
          entry.inFlight = false;
          if (!definitelyRejected(error)) throw error;
          pending = pending.filter((item) => item !== entry);
          definiteError = error;
        }
      }
      if (response === undefined) throw definiteError ?? new Error("Collaboration unavailable");
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
