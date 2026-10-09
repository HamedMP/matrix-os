import { realpath } from "node:fs/promises";
import type { DiscoveredLocalChat } from "./local-chat-discovery";
import { createHash, randomUUID } from "node:crypto";
import { openLocalChatSource } from "@finnaai/matrix/local-chat-import";
import { createLocalChatHttpTransport, uploadLocalChatArchive, LocalChatTransferError, localChatImportErrorText, LOCAL_CHAT_IMPORT_BATCH_LIMIT, LOCAL_CHAT_DISCOVERY_LIMIT, type ImportHarness, type LocalChatImportProgress, type LocalChatSourcePreview } from "@matrix-os/contracts/local-chat-import";
import { LOCAL_CHAT_IMPORT_INVOKE, ChatImportSessionSchema } from "../../shared/local-chat-import-ipc";
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
    catalogKey?: string;
};
type RetryIdentity = Pick<Selection, "capture" | "preview">;
interface Deps {
    auth: {
        getToken(): string | null;
        getGatewayOrigin(): string;
        getStatus(): Session & {
            signedIn: boolean;
            userId?: string;
        };
    };
    chooseFile?(harness: ImportHarness): Promise<string | null>;
    discoverSources?(signal: AbortSignal): Promise<{ sources: DiscoveredLocalChat[]; limited: boolean }>;
    chooseFiles?(harness: ImportHarness): Promise<string[] | null>;
    transfer?: typeof uploadLocalChatArchive;
    progress?(event: Session & LocalChatImportProgress & {
        selectionId: string;
    }): void;
    fetchImpl?: typeof fetch;
}
/** Trusted discovery, legacy selection and native network I/O. Renderer inputs never contain local paths or upload URLs. */
export function createNativeChatImportService(deps: Deps) {
    const selections = new Map<string, Selection>(); // 128 selections, one hour TTL, recurring eviction, no open descriptors.
    const maxSelections = 128;
    const catalog = new Map<string, { source: DiscoveredLocalChat; bound: Bound; expiresAt: number; retry?: RetryIdentity }>(); // 20,000 entries; 15-minute discovery TTL or 24-hour selected queue TTL; recurring eviction, metadata only.
    let controller: AbortController | null = null;
    let pending: Promise<unknown> | null = null;
    let disposed = false;
    let cancellationEpoch = 0;
    let pickerActive=false;
    let catalogSweepAt=0;
    const sweep = () => { const now = Date.now(); for (const [id, value] of selections)
        if (value.expiresAt <= now || !current(value.bound))
            selections.delete(id);
        // A streaming queue calls prepare for each Chat. Sweep its large catalog at most once per minute.
        if(now-catalogSweepAt>=60000){catalogSweepAt=now;for(const [id,value] of catalog)if(value.expiresAt<=now || !current(value.bound))catalog.delete(id);}
    };
    const timer = setInterval(sweep, 60000);
    timer.unref();
    const bound = (request: Session): Bound | null => { const state = deps.auth.getStatus(); const token = deps.auth.getToken(); return state.signedIn && state.userId && token && state.runtimeSlot === request.runtimeSlot && state.authGeneration === request.authGeneration ? { ...request, userId: state.userId, token, origin: deps.auth.getGatewayOrigin() } : null; };
    const current = (value: Bound) => { const live = bound(value); return !!live && live.userId === value.userId && live.token === value.token && live.origin === value.origin; };
    async function run<T>(action: (operation: AbortController) => Promise<T>): Promise<T | {
        status: "error";
        message: string;
    } | { status:"cancelled" }> {
        const epoch=cancellationEpoch;
        // Effect replay and user cancellation may restart before the old I/O unwinds.
        // Drain only aborted work, preserving one active native operation.
        if (pending && controller?.signal.aborted) {
            try { await pending; }
            catch(error:unknown) { console.warn("[chat-import] cancelled operation failed",error instanceof Error ? error.name : "UnknownError"); }
        }
        if(epoch!==cancellationEpoch)return {status:"cancelled"};
        if (disposed || pending || pickerActive)
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
    async function previewPaths(paths: string[], harness: ImportHarness, owner: Bound, operation: AbortController, multiple: boolean, defaultTitle?: string) {
        const staged: Array<{selectionId: string; value: Selection}> = [];
        const errors: string[] = [];
                if (paths.length > LOCAL_CHAT_IMPORT_BATCH_LIMIT) return { status: "error" as const, message: "Choose up to 32 transcripts at a time." };
                sweep();
                if (selections.size + paths.length > maxSelections) return { status: "error" as const, message: "Too many transcript previews are open. Reopen Settings and select your files again." };
                for (const path of paths) {
                    let source: Source | undefined;
                    try {
                        operation.signal.throwIfAborted();
                        source = await openLocalChatSource(path);
                        const parsedPreview = await source.preview(harness, AbortSignal.any([operation.signal, AbortSignal.timeout(5 * 60_000)]));
                        const preview = defaultTitle === undefined ? parsedPreview : { ...parsedPreview, title: defaultTitle };
                        staged.push({ selectionId: randomUUID(), value: { path, capture: source.capture, preview, bound: owner, expiresAt: Date.now() + 60 * 60000 } });
                    } catch (error: unknown) {
                        if (operation.signal.aborted || !current(owner)) return { status: "cancelled" as const };
                        console.warn("[chat-import] native preview failed", error instanceof Error ? error.name : "UnknownError");
                        errors.push(localChatImportErrorText(error));
                    } finally { await source?.close(); }
                }
                if (operation.signal.aborted || !current(owner)) return { status: "cancelled" as const };
                for (const item of staged) selections.set(item.selectionId, item.value);
                if (multiple) return { status: "selected-many" as const, selections: staged.map(({selectionId, value}) => ({selectionId, preview: value.preview})), errors };
                const first = staged[0];
                return first ? { status: "selected" as const, selectionId: first.selectionId, preview: first.value.preview } : { status: "error" as const, message: errors[0] ?? "Choose a supported transcript." };
    }
    async function discover(input: Session) {
        const parsed = ChatImportSessionSchema.safeParse(input);
        const owner = parsed.success ? bound(parsed.data) : null;
        if (!owner) return { status: "cancelled" as const };
        return run(async operation => {
            try {
                if (!deps.discoverSources) return { status: "error" as const, message: "Chat import unavailable. Check your connection and Matrix version, then retry. Your local file was not changed." };
                const result = await deps.discoverSources(AbortSignal.any([operation.signal, AbortSignal.timeout(3*60_000)]));
                if (operation.signal.aborted || !current(owner)) return { status: "cancelled" as const };
                catalog.clear();
                const sources = result.sources.slice(0,LOCAL_CHAT_DISCOVERY_LIMIT).map(source => {
                    const sourceKey = randomUUID(); catalog.set(sourceKey, {source, bound:owner, expiresAt:Date.now()+15*60_000});
                    const {path: _path, ...display} = source;
                    return {sourceKey,...display};
                });
                return {status:"discovered" as const,sources,limited:result.limited || result.sources.length>LOCAL_CHAT_DISCOVERY_LIMIT};
            } catch (error: unknown) {
                if (operation.signal.aborted || !current(owner)) return { status: "cancelled" as const };
                console.warn("[chat-import] local discovery failed", error instanceof Error ? error.name : "UnknownError");
                return {status:"error" as const,message:localChatImportErrorText(error)};
            }
        });
    }
    function reserve(input: z.infer<typeof LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-reserve"]["request"]>) {
        const parsed=LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-reserve"].request.safeParse(input);
        if(!parsed.success || disposed)return {ok:false};
        const owner=bound(parsed.data);if(!owner)return {ok:false};
        const entries=parsed.data.sourceKeys.map(key=>catalog.get(key));const now=Date.now();
        // Validate the complete queue before extending any entry: unknown, expired or foreign IDs fail atomically.
        if(entries.some(entry=>!entry || entry.expiresAt<=now || !current(entry.bound) || entry.bound.userId!==owner.userId || entry.bound.runtimeSlot!==owner.runtimeSlot || entry.bound.authGeneration!==owner.authGeneration))return {ok:false};
        for(const entry of entries)if(entry)entry.expiresAt=now+24*60*60_000;
        return {ok:true};
    }
    async function prepare(input: z.infer<typeof LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-prepare"]["request"]>) {
        const parsed = LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-prepare"].request.safeParse(input); sweep();
        const owner = parsed.success ? bound(parsed.data) : null;
        if (!parsed.success || !owner) return {status:"cancelled" as const};
        const entries = parsed.data.sourceKeys.map(key=>catalog.get(key));
        if (entries.some(entry=>!entry || entry.expiresAt<=Date.now() || !current(entry.bound) || entry.bound.userId!==owner.userId || entry.bound.runtimeSlot!==owner.runtimeSlot || entry.bound.authGeneration!==owner.authGeneration)) return {status:"error" as const,message:"Local conversations changed. Refresh the list and select them again."};
        return run(async operation=>{
            const prepared: Array<{selectionId:string;preview:LocalChatSourcePreview}>=[]; const errors:string[]=[];
            let returned=false;
            try {
                for(const [index,entry] of entries.entries()) {
                    if(operation.signal.aborted) return {status:"cancelled" as const};
                    if (!entry || !current(owner)) return {status:"cancelled" as const};
                    try {
                        const catalogKey=parsed.data.sourceKeys[index]!;
                        if(entry.retry){
                            if(selections.size>=maxSelections){errors.push("Too many transcript previews are open. Reopen Settings and select your files again.");continue;}
                            // Preserve the attempted upload identity even when its local file was removed or grew.
                            const selectionId=randomUUID();
                            selections.set(selectionId,{path:entry.source.path,...entry.retry,bound:owner,expiresAt:Date.now()+60*60000,catalogKey});
                            prepared.push({selectionId,preview:entry.retry.preview});
                            continue;
                        }
                        if (await realpath(entry.source.path) !== entry.source.path) { errors.push(localChatImportErrorText(new LocalChatTransferError("source_changed"))); continue; }
                        const result = await previewPaths([entry.source.path],entry.source.harness,owner,operation,true,entry.source.title);
                        if(result.status==="selected-many") {
                            for(const selected of result.selections){const value=selections.get(selected.selectionId);if(value)value.catalogKey=catalogKey;}
                            prepared.push(...result.selections); errors.push(...result.errors);
                        }
                        else if(result.status==="error") errors.push(result.message);
                        else return result;
                    } catch(error:unknown) {
                        if(operation.signal.aborted || !current(owner)) return {status:"cancelled" as const};
                        console.warn("[chat-import] selected discovery unavailable",error instanceof Error ? error.name : "UnknownError");
                        errors.push(localChatImportErrorText(error));
                    }
                }
                if(operation.signal.aborted || !current(owner))return {status:"cancelled" as const};
                returned=true;
                return {status:"selected-many" as const,selections:prepared,errors};
            }finally{
                // A cancelled batch never returns IDs to the renderer. Release only its hidden previews.
                if(!returned)for(const selection of prepared)selections.delete(selection.selectionId);
            }
        });
    }
    async function select(input: Select) {
        const parsed = LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-select"].request.safeParse(input);
        if (!parsed.success)
            return { status: "error" as const, message: "Choose a supported transcript." };
        const owner = bound(parsed.data);
        if (!owner)
            return { status: "cancelled" as const };
        return run(async (operation) => {
            try {
                operation.signal.throwIfAborted();
                pickerActive = true;
                const picker = Promise.resolve().then(async () => {
                    operation.signal.throwIfAborted();
                    if (parsed.data.multiple && deps.chooseFiles) return deps.chooseFiles(parsed.data.harness);
                    const path = await deps.chooseFile?.(parsed.data.harness);
                    return path ? [path] : null;
                });
                void picker.then(() => { pickerActive = false; }, (error: unknown) => { pickerActive = false; console.warn("[chat-import] picker closed", error instanceof Error ? error.name : "UnknownError"); });
                let onAbort: () => void = () => {};
                let paths: string[] | null;
                try {
                    paths = await Promise.race([picker, new Promise<never>((_resolve, reject) => {
                        onAbort = () => reject(new DOMException("Cancelled", "AbortError"));
                        operation.signal.addEventListener("abort", onAbort, { once: true });
                    })]);
                } finally { operation.signal.removeEventListener("abort", onAbort); }
                if (!paths?.length || operation.signal.aborted || !current(owner)) return { status: "cancelled" as const };
                return await previewPaths(paths, parsed.data.harness, owner, operation, Boolean(parsed.data.multiple));
            } catch (error: unknown) {
                if (operation.signal.aborted || !current(owner)) return { status: "cancelled" as const };
                console.warn("[chat-import] native preview failed", error instanceof Error ? error.name : "UnknownError");
                return { status: "error" as const, message: localChatImportErrorText(error) };
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
                const entry=value.catalogKey ? catalog.get(value.catalogKey) : undefined;
                if(entry && current(entry.bound)){
                    // Freeze before the first request; release may follow a lost or cancelled server result.
                    entry.retry ??= {capture:value.capture,preview:value.preview};
                    value.capture=entry.retry.capture;value.preview=entry.retry.preview;
                }
                const preview = value.preview;
                const uploadSource={
                    rawSize:preview.rawBytes,
                    createHash(){const hash=createHash("sha256");return {update(bytes:Uint8Array){hash.update(bytes);},digest(){return hash.digest("hex");}};},
                    async read(offset:number,length:number,signal:AbortSignal){
                        assertCurrent();
                        if(!source){
                            // Published jobs recover without a local file. Only unfinished uploads need bytes.
                            try{source=await openLocalChatSource(value.path,value.capture);}
                            catch(error:unknown){assertCurrent();console.warn("[chat-import] original capture unavailable",error instanceof Error ? error.name : "UnknownError");throw new LocalChatTransferError("source_changed");}
                            const verificationSignal=AbortSignal.any([signal,operation.signal,AbortSignal.timeout(5*60_000)]);
                            const hash=source.createHash();
                            for(let position=0;position<preview.rawBytes;position+=64*1024){
                                assertCurrent();
                                // Verify sequential chunks to bound transcript memory before uploading.
                                // eslint-disable-next-line react-doctor/async-await-in-loop
                                hash.update(await source.read(position,Math.min(64*1024,preview.rawBytes-position),verificationSignal));
                            }
                            if(hash.digest()!==preview.sourceHash)throw new LocalChatTransferError("source_changed");
                        }
                        assertCurrent();return source.read(offset,length,signal);
                    },
                };
                const transport = createLocalChatHttpTransport({ baseUrl: value.bound.origin, runtimeSlot: value.bound.runtimeSlot, headers: () => ({ Authorization: `Bearer ${value.bound.token}` }), fetchImpl: deps.fetchImpl, assertCurrent, validateUploadUrl: validateDriveTransferUrl });
                const result = await (deps.transfer ?? uploadLocalChatArchive)({ harness: preview.harness, sourceId: preview.sourceId, ...(preview.sourceAgentId ? { sourceAgentId: preview.sourceAgentId } : {}), sourceHash: preview.sourceHash, rawSize: preview.rawBytes, title: parsed.data.title }, uploadSource, transport, { signal: operation.signal, onProgress: progress => { assertCurrent(); deps.progress?.({ ...progress, selectionId: parsed.data.selectionId, runtimeSlot: value.bound.runtimeSlot, authGeneration: value.bound.authGeneration }); } });
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
    function release(input: z.infer<typeof LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-release"]["request"]>) {
        const parsed=LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-release"].request.safeParse(input);
        const owner=parsed.success ? bound(parsed.data) : null;
        if(!parsed.success || !owner)return {ok:false};
        for(const id of parsed.data.selectionIds){
            const value=selections.get(id);
            if(value && current(value.bound) && value.bound.userId===owner.userId && value.bound.runtimeSlot===owner.runtimeSlot && value.bound.authGeneration===owner.authGeneration)selections.delete(id);
        }
        return {ok:true};
    }
    function pause(request: z.infer<typeof LOCAL_CHAT_IMPORT_INVOKE["runtime:chat-import-pause"]["request"]>) {
        if (bound(request)) { cancellationEpoch++; controller?.abort(); if (request.discardSelections) { selections.clear(); catalog.clear(); } }
        return { ok: true };
    }
    function cancelAll() { cancellationEpoch++; controller?.abort(); selections.clear(); catalog.clear(); }
    return { discover, reserve, prepare, select, apply, release, pause, cancelAll, async dispose() { disposed = true; clearInterval(timer); cancelAll(); await pending; } };
}
