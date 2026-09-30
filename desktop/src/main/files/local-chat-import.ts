import { randomUUID } from "node:crypto";
import { openLocalChatSource } from "@finnaai/matrix/local-chat-import";
import { createLocalChatHttpTransport, uploadLocalChatArchive, localChatImportErrorText, type ImportHarness, type LocalChatImportProgress, type LocalChatSourcePreview } from "@matrix-os/contracts/local-chat-import";
import { LOCAL_CHAT_IMPORT_INVOKE, type ChatImportSessionSchema } from "../../shared/local-chat-import-ipc";
import type { z } from "zod/v4";
import { validateDriveTransferUrl } from "./organization-drive-transfer-url";
type Session = z.infer<typeof ChatImportSessionSchema>;
type Select = z.infer<typeof LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-select"]["request"]>;
type Apply = z.infer<typeof LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-apply"]["request"]>;
type Source = Awaited<ReturnType<typeof openLocalChatSource>>;
type Bound = Session & {
    userId: string;
    token: string;
    origin: string;
};
type Selection = {
    path: string;
    capture: Source["capture"];
    preview: LocalChatSourcePreview;
    bound: Bound;
    expiresAt: number;
};
interface Deps {
    auth: {
        getToken(): string | null;
        getGatewayOrigin(): string;
        getStatus(): Session & {
            signedIn: boolean;
            userId?: string;
        };
    };
    chooseFile(harness: ImportHarness): Promise<string | null>;
    transfer?: typeof uploadLocalChatArchive;
    progress?(event: Session & LocalChatImportProgress & {
        selectionId: string;
    }): void;
    fetchImpl?: typeof fetch;
}
/** Trusted picker and native network I/O. Renderer inputs never contain local paths or upload URLs. */
export function createNativeChatImportService(deps: Deps) {
    const selections = new Map<string, Selection>(); // 4 selections, one hour TTL, recurring eviction, no open descriptors.
    let controller: AbortController | null = null;
    let pending: Promise<unknown> | null = null;
    let disposed = false;
    const sweep = () => { const now = Date.now(); for (const [id, value] of selections)
        if (value.expiresAt <= now)
            selections.delete(id); };
    const timer = setInterval(sweep, 60000);
    timer.unref();
    const bound = (request: Session): Bound | null => { const state = deps.auth.getStatus(); const token = deps.auth.getToken(); return state.signedIn && state.userId && token && state.runtimeSlot === request.runtimeSlot && state.authGeneration === request.authGeneration ? { ...request, userId: state.userId, token, origin: deps.auth.getGatewayOrigin() } : null; };
    const current = (value: Bound) => { const live = bound(value); return !!live && live.userId === value.userId && live.token === value.token && live.origin === value.origin; };
    async function run<T>(action: (operation: AbortController) => Promise<T>): Promise<T | {
        status: "error";
        message: string;
    }> {
        if (disposed || pending)
            return { status: "error", message: "Another import is in progress. Try again when it finishes." };
        const operation = new AbortController();
        controller = operation;
        const task = action(operation);
        pending = task;
        try {
            return await task;
        }
        finally {
            if (controller === operation)
                controller = null;
            if (pending === task)
                pending = null;
        }
    }
    async function select(input: Select) {
        const parsed = LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-select"].request.safeParse(input);
        if (!parsed.success)
            return { status: "error" as const, message: "Choose a supported transcript." };
        const owner = bound(parsed.data);
        if (!owner)
            return { status: "cancelled" as const };
        return run(async (operation) => {
            let source: Source | undefined;
            try {
                const path = await deps.chooseFile(parsed.data.harness);
                if (!path || operation.signal.aborted || !current(owner))
                    return { status: "cancelled" as const };
                source = await openLocalChatSource(path);
                const preview = await source.preview(parsed.data.harness, operation.signal);
                if (operation.signal.aborted || !current(owner))
                    return { status: "cancelled" as const };
                sweep();
                if (selections.size >= 4)
                    selections.delete(selections.keys().next().value!);
                const selectionId = randomUUID();
                selections.set(selectionId, { path, capture: source.capture, preview, bound: owner, expiresAt: Date.now() + 60 * 60000 });
                return { status: "selected" as const, selectionId, preview };
            }
            catch (error: unknown) {
                if (operation.signal.aborted || !current(owner))
                    return { status: "cancelled" as const };
                console.warn("[chat-import] native preview failed", error instanceof Error ? error.name : "UnknownError");
                return { status: "error" as const, message: localChatImportErrorText(error) };
            }
            finally {
                await source?.close();
            }
        });
    }
    async function apply(input: Apply) {
        const parsed = LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-apply"].request.safeParse(input);
        sweep();
        if (!parsed.success)
            return { status: "error" as const, message: "Choose a supported transcript." };
        const value = selections.get(parsed.data.selectionId);
        if (!value || !current(value.bound) || value.bound.authGeneration !== parsed.data.authGeneration || value.bound.runtimeSlot !== parsed.data.runtimeSlot)
            return { status: "cancelled" as const };
        return run(async (operation) => {
            let source: Source | undefined;
            const assertCurrent = () => { if (operation.signal.aborted || !current(value.bound))
                throw new DOMException("Cancelled", "AbortError"); };
            try {
                assertCurrent();
                source = await openLocalChatSource(value.path, value.capture);
                assertCurrent();
                const transport = createLocalChatHttpTransport({ baseUrl: value.bound.origin, runtimeSlot: value.bound.runtimeSlot, headers: () => ({ Authorization: `Bearer ${value.bound.token}` }), fetchImpl: deps.fetchImpl, assertCurrent, validateUploadUrl: validateDriveTransferUrl });
                const preview = value.preview;
                const result = await (deps.transfer ?? uploadLocalChatArchive)({ harness: preview.harness, sourceId: preview.sourceId, ...(preview.sourceAgentId ? { sourceAgentId: preview.sourceAgentId } : {}), sourceHash: preview.sourceHash, rawSize: preview.rawBytes, title: parsed.data.title }, source, transport, { signal: operation.signal, onProgress: progress => { assertCurrent(); deps.progress?.({ ...progress, selectionId: parsed.data.selectionId, runtimeSlot: value.bound.runtimeSlot, authGeneration: value.bound.authGeneration }); } });
                assertCurrent();
                selections.delete(parsed.data.selectionId);
                return { status: "imported" as const, ...result };
            }
            catch (error: unknown) {
                if (operation.signal.aborted || !current(value.bound))
                    return { status: "cancelled" as const };
                console.warn("[chat-import] native upload failed", error instanceof Error ? error.name : "UnknownError");
                return { status: "error" as const, message: localChatImportErrorText(error) };
            }
            finally {
                await source?.close();
            }
        });
    }
    function pause(request: Session) { if (bound(request))
        controller?.abort(); return { ok: true }; }
    function cancelAll() { controller?.abort(); selections.clear(); }
    return { select, apply, pause, cancelAll, async dispose() { disposed = true; clearInterval(timer); cancelAll(); await pending; } };
}
