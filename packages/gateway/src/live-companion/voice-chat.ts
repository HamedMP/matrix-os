import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import {
  CanonicalChatIdSchema,
  MATRIX_PI_CHAT_INSTANCE_ID,
  type CanonicalChatModelSelection,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import type { ChatRepository } from "../chat/repository.js";
import { ChatNotFoundError } from "../chat/errors.js";
import type { RequestPrincipal } from "../request-principal.js";

export class VoiceRouteUnavailableError extends Error {
  readonly code = "provider_unavailable";
  constructor() { super("Voice route unavailable"); this.name = "VoiceRouteUnavailableError"; }
}

export interface VoiceChatTarget {
  chatId: string;
  selection: CanonicalChatModelSelection | undefined;
  created: boolean;
}

export function matrixPiSelection(catalog: CanonicalProviderCatalog): CanonicalChatModelSelection | undefined {
  const instance = catalog.instances.find(candidate => candidate.id === MATRIX_PI_CHAT_INSTANCE_ID
    && candidate.driverKind === "matrix_pi" && candidate.availability === "available");
  return instance?.defaultSelection;
}

/** Voice joins an explicit owned Chat, else the owner's most recent generic
 * (no project, unshared) Matrix Pi Chat, else a new one on the Pi route. */
export async function resolveVoiceChat(options: {
  repository: ChatRepository;
  principal: RequestPrincipal;
  piSelection(): Promise<CanonicalChatModelSelection | undefined>;
  chatId?: string;
}): Promise<VoiceChatTarget> {
  const { repository, principal } = options;
  const owner = { type: "personal" as const, ownerId: principal.userId };
  if (options.chatId !== undefined) {
    const chatId = CanonicalChatIdSchema.parse(options.chatId);
    const record = await repository.get(owner, chatId);
    if (!record || record.chat.collaboration || record.chat.lifecycle !== "active") throw new ChatNotFoundError(chatId);
    return { chatId, selection: record.chat.currentSelection ?? await options.piSelection(), created: false };
  }
  const recent = await repository.kysely.selectFrom("chats").select(["id", "current_selection"])
    .where("owner_type", "=", "personal").where("owner_id", "=", principal.userId)
    .where("project_id", "is", null).where("collaboration", "is", null).where("lifecycle", "=", "active")
    .where("id", "not like", "chat_live_task_%")
    .where(eb => eb.or([
      eb("bound_instance_id", "=", MATRIX_PI_CHAT_INSTANCE_ID),
      eb.and([eb("bound_instance_id", "is", null),
        eb(sql<string>`current_selection->>'instanceId'`, "=", MATRIX_PI_CHAT_INSTANCE_ID)]),
    ]))
    .orderBy("activity_at", "desc").orderBy("id", "desc").limit(1).executeTakeFirst();
  if (recent) {
    const record = await repository.get(owner, recent.id);
    if (record) return { chatId: recent.id, selection: record.chat.currentSelection ?? await options.piSelection(), created: false };
  }
  const selection = await options.piSelection();
  if (!selection) throw new VoiceRouteUnavailableError();
  const suffix = randomBytes(12).toString("hex");
  const record = await repository.create(owner, { id: `chat_voice_${suffix}`, clientRequestId: `req_voice_${suffix}`,
    title: "Voice", currentSelection: selection });
  return { chatId: record.chat.id, selection, created: true };
}
