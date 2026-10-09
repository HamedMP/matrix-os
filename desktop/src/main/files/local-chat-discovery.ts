import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod/v4";
import { LOCAL_CHAT_DISCOVERY_LIMIT, type ImportHarness } from "@matrix-os/contracts/local-chat-import";
export interface DiscoveredLocalChat {
    path: string; harness: ImportHarness; title: string; rawBytes: number; updatedAt: string; recordedDirectory?: string;
}
interface Options { home: string; codexRoot?: string; claudeRoot?: string; maxCandidates?: number }
function missing(error: unknown): boolean { return error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(String(error.code)); }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function label(value: unknown, max: number): string | undefined { return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,max) || undefined : undefined; }
function userText(record: Record<string, unknown>, harness: ImportHarness): string | undefined {
    const payload = object(record.payload); const message = harness === "claude" ? object(record.message) : record.type === "response_item" ? payload : record;
    if (harness === "claude" ? record.type !== "user" || record.isMeta || record.isCompactSummary : (message.role !== "user" && message.type !== "UserMessage")) return;
    const content = message.content ?? message.text;
    if (typeof content === "string") return label(content,160);
    if (Array.isArray(content)) for (const part of content) { const value = object(part); if (["text","input_text"].includes(String(value.type)) && typeof value.text === "string") return label(value.text,160); }
}
async function metadata(source: DiscoveredLocalChat, signal: AbortSignal): Promise<DiscoveredLocalChat & {sessionId?: string; subagent?: boolean}> {
    signal.throwIfAborted();
    let file;
    try {
        file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await file.stat(); if (!stat.isFile()) return source;
        // At most 128 KiB per candidate. Full validation/hash happens only after selection.
        const chunks: string[] = [];
        const head = Buffer.alloc(Math.min(stat.size,64 * 1024));
        const first = await file.read(head,0,head.length,0); chunks.push(head.subarray(0,first.bytesRead).toString("utf8"));
        if (stat.size > head.length) { const tail = Buffer.alloc(Math.min(stat.size-head.length,64*1024)); const last = await file.read(tail,0,tail.length,stat.size-tail.length); chunks.push(tail.subarray(0,last.bytesRead).toString("utf8")); }
        let sessionId: string | undefined; let subagent = false;
        let title: string | undefined; let explicitTitle: string | undefined; let recordedDirectory: string | undefined;
        for (const chunk of chunks) for (const line of chunk.split("\n")) {
            signal.throwIfAborted();
            let value: unknown;
            try { value = JSON.parse(line); } catch (error: unknown) { if (!(error instanceof SyntaxError)) throw error; continue; }
            const record = object(value);
            const meta = record.type === "session_meta" ? object(record.payload) : record;
            if (source.harness === "codex") { sessionId ??= label(meta.id ?? meta.session_id,128); subagent ||= Boolean(object(meta.source).subagent); }
            recordedDirectory ??= label(record.cwd ?? object(record.payload).cwd,4096);
            title ??= userText(record,source.harness);
            if (record.type === "custom-title") explicitTitle = label(record.customTitle,160) ?? explicitTitle;
            if (record.type === "summary") explicitTitle = label(record.summary,160) ?? explicitTitle;
        }
        return {...source,sessionId,subagent,title:explicitTitle ?? title ?? source.title,...(recordedDirectory ? {recordedDirectory} : {})};
    } catch (error: unknown) {
        if (signal.aborted) throw signal.reason;
        if (!missing(error) && !(error instanceof Error && "code" in error && error.code === "ELOOP")) console.warn("[chat-import] discovery metadata unavailable",error instanceof Error ? error.name : "UnknownError");
        return source;
    } finally { await file?.close(); }
}
async function codexTitles(path:string, ids:string[], signal:AbortSignal):Promise<Map<string,string>> {
    const wanted = new Set(ids.slice(0,LOCAL_CHAT_DISCOVERY_LIMIT)); const titles = new Map<string,string>(); // scan-scoped, <=20,000 keys; title bytes remain bounded to 2 MiB.
    let file;
    try {
        signal.throwIfAborted(); const info=await lstat(path); if(!info.isFile() || info.isSymbolicLink())return titles;
        file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const stat=await file.stat();if(!stat.isFile() || stat.dev!==info.dev || stat.ino!==info.ino)return titles;
        const bytes=Buffer.alloc(Math.min(stat.size,2*1024**2));const offset=Math.max(0,stat.size-bytes.length);
        const read=await file.read(bytes,0,bytes.length,offset);const lines=bytes.subarray(0,read.bytesRead).toString("utf8").split("\n");
        for(const line of offset ? lines.slice(1) : lines) {
            signal.throwIfAborted();let record:Record<string,unknown>;
            try {record=object(JSON.parse(line));}catch(error:unknown){if(!(error instanceof SyntaxError))throw error;continue;}
            if(typeof record.id!=="string" || !wanted.has(record.id) || !z.uuid().safeParse(record.id).success)continue;
            const title=label(record.thread_name,160);if(title)titles.set(record.id,title);
        }
    }catch(error:unknown){if(signal.aborted)throw signal.reason;if(!missing(error))console.warn("[chat-import] local title index unavailable",error instanceof Error?error.name:"UnknownError");}
    finally{await file?.close();}
    return titles;
}
/** Restricted local roots only. Never follows adjacent history, credentials, subagents or symlinks. */
export async function discoverLocalChats(options: Options, signal: AbortSignal): Promise<{sources: DiscoveredLocalChat[]; limited: boolean}> {
    signal.throwIfAborted();
    const roots = [
        {path:join(options.codexRoot ?? join(options.home,".codex"),"sessions"),harness:"codex" as const},
        {path:join(options.codexRoot ?? join(options.home,".codex"),"archived_sessions"),harness:"codex" as const},
        {path:join(options.claudeRoot ?? join(options.home,".claude"),"projects"),harness:"claude" as const},
    ];
    const limit = Math.min(LOCAL_CHAT_DISCOVERY_LIMIT,Math.max(1,options.maxCandidates ?? LOCAL_CHAT_DISCOVERY_LIMIT));
    const candidates: DiscoveredLocalChat[] = []; let scanned = 0; let limited = false;
    const deadline = Date.now()+2*60_000;
    rootsLoop: for (const root of roots) {
        let canonical: string;
        try { const stat = await lstat(root.path); if (!stat.isDirectory() || stat.isSymbolicLink()) continue; canonical = await realpath(root.path); }
        catch (error: unknown) { if (missing(error)) continue; throw error; }
        const pending = [{path:canonical,depth:0}]; // DFS stack, max 20,000 directories, max depth 8.
        while (pending.length) {
            signal.throwIfAborted();
            if (scanned >= LOCAL_CHAT_DISCOVERY_LIMIT || Date.now() > deadline) { limited=true; break; }
            const directory=pending.pop()!;
            try {
                if ((await realpath(directory.path)) !== directory.path || (await lstat(directory.path)).isSymbolicLink()) continue;
                const handle=await opendir(directory.path);
                for await (const entry of handle) {
                    signal.throwIfAborted();
                    if (++scanned > LOCAL_CHAT_DISCOVERY_LIMIT || Date.now() > deadline) {limited=true;break;}
                    if (entry.isSymbolicLink() || entry.name === "subagents") continue;
                    const path=join(directory.path,entry.name);
                    if(entry.isDirectory()) { if(directory.depth < 8 && pending.length < LOCAL_CHAT_DISCOVERY_LIMIT) pending.push({path,depth:directory.depth+1}); else limited=true; continue; }
                    if(!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.startsWith("agent-") || entry.name === "history.jsonl") continue;
                    const info=await lstat(path); if(!info.isFile() || info.isSymbolicLink() || info.size<1 || info.size>20*1024**3) continue;
                    if(candidates.length>=limit){limited=true;break rootsLoop;}
                    candidates.push({path,harness:root.harness,title:`${root.harness === "codex" ? "Codex" : "Claude Code"} conversation ${basename(path,".jsonl").slice(-12)}`,rawBytes:info.size,updatedAt:info.mtime.toISOString()});
                }
            } catch(error:unknown) { if(signal.aborted) throw signal.reason; if(!missing(error)) throw error; }
        }
    }
    const inspected: Array<DiscoveredLocalChat & {sessionId?:string;subagent?:boolean}>=[];
    for(const candidate of candidates.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))) {
        signal.throwIfAborted();if(Date.now()>deadline){limited=true;break;}
        inspected.push(await metadata(candidate,signal));
    }
    const titles = await codexTitles(join(options.codexRoot ?? join(options.home,".codex"),"session_index.jsonl"), inspected.flatMap(source => source.sessionId ? [source.sessionId] : []), signal);
    const sources = inspected.filter(source=>!source.subagent).map(({sessionId,subagent:_subagent,...source})=>({...source,title:sessionId && titles.get(sessionId) || source.title}));
    return {sources,limited};
}
