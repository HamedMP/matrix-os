import { localChatImportErrorText, LocalChatImportDisplayError } from "@matrix-os/contracts/local-chat-import";
import type { LocalChatCandidate, LocalImportUpdate, NativeChatImportAdapter } from "./import-state.js";
const STOPPED = "Stopped waiting. Retry this conversation to check its import status.";
/** Prepare, upload and release one transcript before advancing, regardless of library size. */
export async function runLocalImportQueue(sources: LocalChatCandidate[], native: NativeChatImportAdapter,
    signal: AbortSignal, onUpdate: (value: LocalImportUpdate) => void, titles: Record<string, string> = {}) {
    if (!native.prepare || signal.aborted) return;
    await native.reserve?.(sources.map(source => source.sourceKey), signal);
    for (let index = 0; index < sources.length; index++) {
        if (signal.aborted) return;
        const source = sources[index]!;
        const update = (patch: Omit<LocalImportUpdate, "sourceKey" | "title" | "processed" | "total">) => {
            if (!signal.aborted) onUpdate({ sourceKey: source.sourceKey, title: titles[source.sourceKey] ?? source.title,
                processed: index + Number(patch.status === "imported" || patch.status === "failed"), total: sources.length, ...patch });
        };
        let ids: string[] = [];
        try {
            update({ status: "reading" });
            // eslint-disable-next-line react-doctor/async-await-in-loop
            const prepared = await native.prepare([source.sourceKey], signal);
            ids = prepared?.selections.map(selection => selection.selectionId) ?? [];
            if (signal.aborted) return;
            if (!prepared) { update({ status: "failed", error: STOPPED }); return; }
            const selection = prepared.selections[0];
            if (!selection) throw new LocalChatImportDisplayError(prepared.errors[0] ?? "This transcript could not be read.");
            update({ status: "importing" });
            // eslint-disable-next-line react-doctor/async-await-in-loop
            const result = await native.apply(selection.selectionId, (titles[source.sourceKey] ?? source.title).trim(), signal,
                progress => update({ status: "importing", progress }));
            if (signal.aborted) return;
            if (!result) { update({ status: "failed", error: STOPPED }); return; }
            update({ status: "imported", result });
        } catch (cause: unknown) {
            if (signal.aborted) return;
            update({ status: "failed", error: localChatImportErrorText(cause) });
        } finally {
            if (ids.length && native.release) {
                try {
                    // eslint-disable-next-line react-doctor/async-await-in-loop
                    await native.release(ids);
                } catch (cause: unknown) {
                    console.warn("[chat-import] preview release unavailable", cause instanceof Error ? cause.name : "UnknownError");
                }
            }
        }
    }
}
