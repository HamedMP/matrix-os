import { useEffect, useRef, useState } from "react";
import { LOCAL_CHAT_DISCOVERY_LIMIT, localChatImportErrorText, LocalChatImportDisplayError, uploadLocalChatArchive, type ImportHarness, type LocalChatImportProgress } from "@matrix-os/contracts/local-chat-import";
import { createBrowserChatSource } from "./local-source.js";
import { MAX_IMPORT_SELECTIONS, sourceKey, validImportTitle, type ImportItem, type ImportTransport, type NativeChatImportAdapter, type LocalChatCandidate, type LocalChatLibraryState, type LocalImportOutcome, type LocalImportUpdate } from "./import-state.js";
import { runLocalImportQueue } from "./local-import-queue.js";
import { createLocalImportResults } from "./local-import-results.js";
const STOPPED = "Stopped waiting. Retry the same file to check its import status.";
export function useChatImport({ native, transport }: { native?: NativeChatImportAdapter; transport?: ImportTransport }) {
    const [harness, setHarness] = useState<ImportHarness>("codex");
    const [items, setItems] = useState<ImportItem[]>([]);
    const [busy, setBusy] = useState<"reading" | "importing" | null>(null);
    const [batchRevision, setBatchRevision] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [localResults, setLocalResults] = useState<Record<string, LocalImportOutcome>>({});
    const [localActive, setLocalActive] = useState<LocalImportUpdate | null>(null);
    const [localImportedCount, setLocalImportedCount] = useState(0);
    const outcomes = useRef<ReturnType<typeof createLocalImportResults> | null>(null);
    if (!outcomes.current) outcomes.current = createLocalImportResults();
    const active = useRef<LocalImportUpdate | null>(null);
    const library=useLocalSources(native,batchRevision);
    const generation = useRef(0);
    const operation = useRef<AbortController | null>(null);
    useEffect(() => () => { generation.current++; operation.current?.abort(); outcomes.current?.clear(); native?.pause(true); }, [native, transport]);
    function flushResults() { setLocalResults(outcomes.current!.snapshot()); setLocalImportedCount(outcomes.current!.importedCount); }
    function clearResults() { outcomes.current!.clear(); active.current = null; setLocalResults({}); setLocalImportedCount(0); setLocalActive(null); }
    function release(ids: string[]) {
        if(ids.length && native?.release)void native.release(ids).catch((cause:unknown)=>{
            console.warn("[chat-import] preview release unavailable",cause instanceof Error ? cause.name : "UnknownError");
        });
    }
    function begin(phase: "reading" | "importing") {
        if (operation.current) return null;
        const controller = new AbortController(); operation.current = controller;
        const current = ++generation.current;
        setBusy(phase); setError(null);
        return { controller, current, live: () => generation.current === current && !controller.signal.aborted };
    }
    function finish(current: number) {
        if (generation.current === current) { setBusy(null); operation.current = null; }
    }
    async function selectFiles(files?: File[], sourceKeys?: string[]) {
        if ((!sourceKeys && items.length >= MAX_IMPORT_SELECTIONS) || (files && files.length + items.length > MAX_IMPORT_SELECTIONS) || (sourceKeys && sourceKeys.length > 1)) {
            setError(`Choose up to ${MAX_IMPORT_SELECTIONS} transcripts at a time. Remove a preview or start a new batch.`); return;
        }
        const task = begin("reading"); if (!task) return;
        const { controller, current, live } = task;
        const additions: ImportItem[] = []; const errors: string[] = [];
        function add(value: Pick<ImportItem, "preview" | "source" | "selectionId" | "catalogKey">) {
            additions.push({ ...value, key: sourceKey(value.preview), title: value.preview.title, status: "ready" });
        }
        try {
            if (sourceKeys && native?.prepare) {
                const selected = await native.prepare(sourceKeys, controller.signal);
                if (selected) { selected.selections.forEach(selection => add({ preview: selection.preview, catalogKey: sourceKeys[0] })); release(selected.selections.map(selection=>selection.selectionId)); errors.push(...selected.errors.map(message => localChatImportErrorText(new LocalChatImportDisplayError(message)))); }
            } else if (native?.selectMany) {
                const selected = await native.selectMany(harness, controller.signal);
                if (selected) { selected.selections.forEach(add); errors.push(...selected.errors.map(message => localChatImportErrorText(new LocalChatImportDisplayError(message)))); }
            } else if (native?.select) {
                const selected = await native.select(harness, controller.signal); if (selected) add(selected);
            } else if (files) {
                for (const file of files) {
                    if (!live()) return;
                    try {
                        const source = createBrowserChatSource(file);
                        // Parse one transcript at a time to cap captured-byte memory.
                        // eslint-disable-next-line react-doctor/async-await-in-loop
                        const preview = await source.preview(harness, controller.signal);
                        add({ preview, source });
                    }
                    catch (cause: unknown) { if (!live()) return; errors.push(localChatImportErrorText(cause)); }
                }
            }
            if (!live()) return;
            const unique = additions.filter((item, index) => !items.some(old => old.key === item.key) && additions.findIndex(other => other.key === item.key) === index);
            if (items.length + unique.length > (sourceKeys ? LOCAL_CHAT_DISCOVERY_LIMIT : MAX_IMPORT_SELECTIONS)) {
                setError(`Choose up to ${MAX_IMPORT_SELECTIONS} transcripts at a time. Remove a preview or start a new batch.`); return;
            }
            const uniqueItems=new Set(unique); // workflow-scoped, capped at the discovery limit, discarded after preview.
            release(additions.filter(item=>!uniqueItems.has(item) && item.selectionId && !items.some(old=>old.selectionId===item.selectionId)).flatMap(item=>item.selectionId?[item.selectionId]:[]));
            setItems(previous => [...previous, ...unique]);
            if (errors.length) setError(`${errors.length === 1 ? "1 transcript could not be read." : `${errors.length} transcripts could not be read.`} ${errors[0]}`);
            else if (additions.length && !unique.length) setError("These transcripts are already in this batch.");
        } catch (cause: unknown) { if (live()) setError(localChatImportErrorText(cause)); }
        finally { finish(current); }
    }
    async function importLocal(keys: string[]) {
        if (!native?.prepare || library.loading || library.error) return;
        const keySet = new Set(keys.slice(0, LOCAL_CHAT_DISCOVERY_LIMIT)); // workflow-scoped bounded selection, discarded after use.
        const queued = library.sources.filter(source => keySet.has(source.sourceKey) && outcomes.current!.get(source.sourceKey)?.status !== "imported");
        if (!queued.length) return;
        const task = begin("importing"); if (!task) return;
        if (items.some(item=>item.catalogKey && keySet.has(item.catalogKey) && !validImportTitle(item.title))) { finish(task.current); setError("Enter a title of 1–160 characters before importing."); return; }
        const titles = Object.fromEntries(items.filter(item => item.catalogKey).map(item => [item.catalogKey!, item.title]));
        try {
            await runLocalImportQueue(queued, native, task.controller.signal, value => {
                if (!task.live()) return;
                active.current = value;
                setLocalActive(value);
                if (value.status === "imported" || value.status === "failed") {
                    const outcome: LocalImportOutcome = { status: value.status, result: value.result, error: value.error };
                    if (outcomes.current!.record(value.sourceKey, outcome)) flushResults();
                    setLocalImportedCount(outcomes.current!.importedCount);
                }
                setItems(previous => previous.map(item => item.catalogKey === value.sourceKey
                    ? { ...item, status: value.status, result: value.result, error: value.error, progress: value.progress } : item));
            }, titles);
        } catch (cause: unknown) { if (task.live()) setError(localChatImportErrorText(cause)); }
        finally { if (task.live()) { flushResults(); active.current = null; setLocalActive(null); } finish(task.current); }
    }
    async function importChats(status: "ready" | "failed" = "ready") {
        const queued = items.filter(item => item.status === status);
        if (!queued.length || queued.some(item => !validImportTitle(item.title))) return;
        if (native?.prepare && queued.every(item=>item.catalogKey)) { await importLocal(queued.map(item=>item.catalogKey!)); return; }
        const task = begin("importing"); if (!task) return;
        const { controller, current, live } = task;
        const update = (key: string, patch: Partial<ImportItem>) => { if (live()) setItems(previous => previous.map(item => item.key === key ? { ...item, ...patch } : item)); };
        try {
            for (const item of queued) {
                if (!live()) return;
                update(item.key, { status: "importing", progress: undefined, error: undefined });
                const preview = item.preview; const title = item.title.trim();
                const onProgress = (progress: LocalChatImportProgress) => update(item.key, { progress });
                try {
                    // Native imports share one session operation; preserve ordering and cancellation.
                    // eslint-disable-next-line react-doctor/async-await-in-loop
                    const result = native && item.selectionId ? await native.apply(item.selectionId, title, controller.signal, onProgress)
                        : transport && item.source ? await uploadLocalChatArchive({ harness: preview.harness, sourceId: preview.sourceId,
                            ...(preview.sourceAgentId ? { sourceAgentId: preview.sourceAgentId } : {}), sourceHash: preview.sourceHash,
                            rawSize: preview.rawBytes, title }, item.source, transport, { signal: controller.signal, onProgress }) : null;
                    if (!live()) return;
                    update(item.key, result ? { status: "imported", result, title, progress: undefined } : { status: "failed", error: STOPPED, progress: undefined });
                } catch (cause: unknown) { if (!live()) return; update(item.key, { status: "failed", error: localChatImportErrorText(cause), progress: undefined }); }
            }
        } finally { finish(current); }
    }
    function pause() {
        generation.current++; operation.current?.abort(); operation.current = null; native?.pause();
        const waiting = active.current;
        if (waiting && (waiting.status === "reading" || waiting.status === "importing")) outcomes.current!.record(waiting.sourceKey, { status: "failed", error: STOPPED });
        flushResults(); active.current = null;
        setLocalActive(null); setBusy(null); setError(busy === "reading" ? STOPPED : null);
        setItems(previous => previous.map(item => item.status === "importing" || item.status === "reading" ? { ...item, status: "failed", error: STOPPED, progress: undefined } : item));
    }
    function changeTitle(key: string, title: string) { if (!operation.current) setItems(previous => previous.map(item => item.key === key && item.status !== "imported" ? { ...item, title } : item)); }
    function remove(key: string) { if (!operation.current) { release(items.filter(item=>item.key===key).flatMap(item=>item.selectionId?[item.selectionId]:[])); setItems(previous => previous.filter(item => item.key !== key)); setError(null); } }
    function reset() { if (!operation.current) { native?.pause(true); setItems([]); clearResults(); setError(null); setBatchRevision(value => value + 1); } }
    const refreshLibrary = () => { if (!operation.current) { clearResults(); setItems(previous=>previous.filter(item=>!item.catalogKey)); library.refresh(); } };
    return { library: { ...library, refresh: refreshLibrary }, localResults, localImportedCount, localActive, importLocal, batchRevision, harness, setHarness, items, busy, error, selectFiles, importChats, pause, changeTitle, remove, reset };
}

function useLocalSources(native: NativeChatImportAdapter | undefined, batchRevision: number): LocalChatLibraryState {
    const [sources,setSources]=useState<LocalChatCandidate[]>([]);
    const [loading,setLoading]=useState(Boolean(native?.discover));
    const [error,setError]=useState<string|null>(null);
    const [limited,setLimited]=useState(false);
    const [revision,setRevision]=useState(0);
    const generation=useRef(0);
    useEffect(()=>{
        if(!native?.discover)return;
        const controller=new AbortController();const current=++generation.current;
        setLoading(true);setError(null);
        void native.discover?.(controller.signal).then(result=>{
            if(controller.signal.aborted || generation.current!==current)return;
            if(result){setSources(result.sources.slice(0,LOCAL_CHAT_DISCOVERY_LIMIT));setLimited(result.limited);}
            else setError("Local conversations are unavailable. Refresh the list to try again.");
        }).catch((cause:unknown)=>{if(!controller.signal.aborted && generation.current===current)setError(localChatImportErrorText(cause));})
            .finally(()=>{if(!controller.signal.aborted && generation.current===current)setLoading(false);});
        return()=>{generation.current++;controller.abort();};
    },[native,revision,batchRevision]);
    return {sources,loading,error,limited,refresh:()=>setRevision(value=>value+1)};
}
