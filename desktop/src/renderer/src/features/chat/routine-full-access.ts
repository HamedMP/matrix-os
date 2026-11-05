import { useMemo } from "react";
import { CanonicalChatIdSchema, RoutineFullAccessStatusSchema, type CanonicalChatSummary, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import { routineFullAccessOwnerUrl, routineFullAccessChatPresentationEligible, type RoutineFullAccessClient, type RoutineFullAccessContext } from "@matrix-os/ui";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import { desktopRoutineConfirmationDestination } from "./routine-action-confirmation";

/** Opens only the selected Computer's owner browser; device turn admission remains unchanged. */
export async function openDesktopRoutineFullAccess(chatId: string, signal?: AbortSignal) {
  CanonicalChatIdSchema.parse(chatId); signal?.throwIfAborted();
  const target = await desktopRoutineConfirmationDestination(); signal?.throwIfAborted();
  const status = RoutineFullAccessStatusSchema.parse(await target.api.get(`${target.prefix}/api/chats/${encodeURIComponent(chatId)}/routine-cli/full-access`,
    { signal, timeoutMs: 10_000, maxBytes: 32 * 1024, cache: "no-store" }));
  if (!target.current() || signal?.aborted || status.eligibility === "ineligible" || status.eligibility === "target_required") throw new Error("Routine CLI access unavailable");
  const url = routineFullAccessOwnerUrl(target.connection.platformHost, target.computer.gatewayPath, chatId);
  if (!target.current() || signal?.aborted) throw new Error("Routine CLI access unavailable");
  await invoke("shell:open-external", { url });
}
export function useNativeRoutineFullAccessContext({ client, chat, selection, catalog, ordinary }: {
  client?: RoutineFullAccessClient;
  chat?: Pick<CanonicalChatSummary, "id" | "ownerScope" | "lifecycle" | "collaboration">;
  selection: { instanceId: string; model: string; interactionMode?: string } | null; catalog: CanonicalProviderCatalog; ordinary: boolean;
}): RoutineFullAccessContext {
  const identity = useConnection(desktopProviderIdentityKey);
  const chatId = chat?.id;
  const driver = catalog.instances.find(instance => instance.id === selection?.instanceId)?.driverKind;
  const manage = routineFullAccessChatPresentationEligible({ chat, ordinary, fresh: true });
  const enabled = manage && driver === "claude_code" && selection?.interactionMode === "default";
  return useMemo(() => ({ client, chatId, identity: JSON.stringify([identity, selection?.instanceId, selection?.model]),
    enabled, manage, browserOrigin: false, openOwnerBrowser: chatId ? (signal?: AbortSignal) => openDesktopRoutineFullAccess(chatId, signal) : undefined }),
  [client, chatId, identity, selection?.instanceId, selection?.model, enabled, manage]);
}
