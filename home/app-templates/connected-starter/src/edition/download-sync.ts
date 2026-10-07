import { parseMessage } from "./transport";
import type { EditionDownloads } from "./offline";
import type { EditionMessage, MailBridge } from "./types";

/** Recheck bounded device copies through the same authorization as online reads. */
export async function refreshDownloads(
  cache: EditionDownloads,
  bridge: MailBridge,
  current: () => boolean,
) {
  for (const stored of cache.list()) {
    if (!current()) return;
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- bounded 50-copy reauthorization is intentionally serial to limit connector/transport load and stop immediately after an owner-generation change.
      const message = parseMessage(await bridge("message", { id: stored.id }));
      if (!current()) return;
      if (message.id !== stored.id || message.sourceId !== stored.sourceId)
        throw new Error("Download binding changed");
      const pending = cache.pending().find((p) => p.id === stored.id);
      const { id, baseRevision, ...values } = pending ?? {
        id: stored.id,
        baseRevision: message.readingRevision,
      };
      cache.download({ ...message, ...values });
    } catch (cause) {
      if (!current()) return;
      console.warn("Edition device copy could not be reauthorized");
      cache.remove(stored.id);
    }
  }
}

/** Visible content needs current authorization too; transport failure is not absence. */
export async function refreshActiveArticle(
  bridge: MailBridge,
  id: string,
  current: () => boolean,
  apply: (message: EditionMessage | null) => void,
) {
  if (!current()) return;
  try {
    const message = parseMessage(await bridge("message", { id }));
    if (!current()) return;
    if (message.id !== id) throw new Error("Article identity changed");
    apply(message);
  } catch (cause) {
    if (!current()) return;
    apply(null);
    throw cause;
  }
}
