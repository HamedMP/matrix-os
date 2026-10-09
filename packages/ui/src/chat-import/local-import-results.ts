import { LOCAL_CHAT_DISCOVERY_LIMIT } from "@matrix-os/contracts/local-chat-import";
import type { LocalImportOutcome } from "./import-state.js";
/** Catalog-scoped outcomes: capped, cleared on refresh/reset/unmount, published every 100 completions. */
export function createLocalImportResults() {
    let values: Record<string, LocalImportOutcome> = Object.create(null);
    let size = 0; let dirty = 0; let importedCount = 0;
    return {
        get importedCount() { return importedCount; },
        get(key: string) { return values[key]; },
        record(key: string, outcome: LocalImportOutcome) {
            const old = values[key];
            if (!old && size >= LOCAL_CHAT_DISCOVERY_LIMIT) return false;
            if (!old) size++;
            importedCount += Number(outcome.status === "imported") - Number(old?.status === "imported");
            values[key] = outcome;
            return ++dirty >= 100;
        },
        snapshot() { dirty = 0; return { ...values }; },
        clear() { values = Object.create(null); size = 0; dirty = 0; importedCount = 0; },
    };
}
