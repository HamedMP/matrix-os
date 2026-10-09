import { mkdtemp, mkdir, writeFile, symlink, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverLocalChats } from "../../desktop/src/main/files/local-chat-discovery";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, {recursive:true,force:true}))); });
async function fixture() { const home = await mkdtemp(join(tmpdir(), "matrix-discovery-")); dirs.push(home); return home; }
async function transcript(home: string, relative: string, records: unknown[]) { const path = join(home, relative); await mkdir(path.slice(0,path.lastIndexOf("/")), {recursive:true}); await writeFile(path, records.map(record=>JSON.stringify(record)).join("\n")+"\n"); return path; }
describe("local conversation discovery", () => {
    it("finds both harnesses and reads bounded display metadata without scanning history, credentials or subagents", async () => {
        const home = await fixture();
        await transcript(home, ".codex/sessions/2026/10/09/rollout.jsonl", [{type:"session_meta",payload:{id:"session",cwd:"/work/codex"}},{type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"Fix upload progress"}]}}]);
        await transcript(home, ".claude/projects/project/session.jsonl", [{type:"user",cwd:"/work/claude",message:{role:"user",content:"Organize imported chats"}}]);
        await transcript(home, ".claude/projects/project/session/subagents/agent-one.jsonl", [{type:"user",message:{content:"Hidden subagent"}}]);
        await transcript(home, ".codex/history.jsonl", [{text:"Global history must be ignored"}]);
        await transcript(home, ".codex/archived_sessions/archived.jsonl", [{type:"session_meta",payload:{id:"session"}},{type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"Archived conversation"}]}}]);
        const result = await discoverLocalChats({home}, new AbortController().signal);
        expect(result.sources.map(source=>source.title).sort()).toEqual(["Archived conversation","Fix upload progress","Organize imported chats"]);
        expect(result.sources.find(source=>source.harness==="claude")?.recordedDirectory).toBe("/work/claude");
    });
    it("uses saved Codex titles, supports legacy records and hides child-agent conversations",async()=>{
        const home=await fixture();const id="019eb0ae-9a30-7541-bdb8-db4d17e65146";
        await transcript(home,".codex/sessions/legacy.jsonl",[{id,cwd:"/work"},{type:"UserMessage",content:"Legacy prompt"}]);
        await transcript(home,".codex/session_index.jsonl",[{id,thread_name:"Saved conversation title",updated_at:"2026-10-01T00:00:00Z"}]);
        await transcript(home,".codex/sessions/child.jsonl",[{type:"session_meta",payload:{id,source:{subagent:{thread_spawn:{agent_path:"child"}}}}},{type:"response_item",payload:{type:"message",role:"user",content:"Inherited"}}]);
        const result=await discoverLocalChats({home},new AbortController().signal);
        expect(result.sources.map(source=>source.title)).toEqual(["Saved conversation title"]);
    });
    it("skips symlinked transcripts and directories, and treats missing roots as an empty catalog", async () => {
        const home = await fixture();
        expect(await discoverLocalChats({home}, new AbortController().signal)).toMatchObject({sources:[]});
        const external = await transcript(home, "outside/session.jsonl", [{type:"user",message:{content:"Do not follow"}}]);
        await mkdir(join(home,".claude/projects"),{recursive:true});
        await symlink(external,join(home,".claude/projects/link.jsonl"));
        await symlink(join(home,"outside"),join(home,".claude/projects/linked"));
        expect((await discoverLocalChats({home},new AbortController().signal)).sources).toEqual([]);
    });
    it("discovers every conversation above the former 100-per-app cap and resolves later Codex titles", async () => {
        const home=await fixture(); const ids=Array.from({length:225},(_,index)=>`019eb0ae-9a30-7541-bdb8-${index.toString(16).padStart(12,"0")}`);
        for(let i=0;i<225;i++) {
            await transcript(home,`.codex/sessions/${i}.jsonl`,[{type:"session_meta",payload:{id:ids[i]}},{type:"response_item",payload:{type:"message",role:"user",content:`Codex ${i}`}}]);
            await transcript(home,`.claude/projects/project/${i}.jsonl`,[{type:"user",message:{content:`Claude ${i}`}}]);
        }
        await transcript(home,".codex/session_index.jsonl",ids.map((id,index)=>({id,thread_name:`Saved ${index}`})));
        const result=await discoverLocalChats({home},new AbortController().signal);
        expect(result.limited).toBe(false);expect(result.sources).toHaveLength(450);
        expect(result.sources.filter(source=>source.harness==="claude")).toHaveLength(225);
        expect(result.sources.filter(source=>source.harness==="codex").every(source=>source.title.startsWith("Saved "))).toBe(true);
    });
    it("keeps an older top-level Codex conversation after inspecting more than 100 newer child agents",async()=>{
        const home=await fixture();const id="019eb0ae-9a30-7541-bdb8-db4d17e65146";
        const older=await transcript(home,".codex/sessions/older.jsonl",[{type:"session_meta",payload:{id}},{type:"response_item",payload:{type:"message",role:"user",content:"Older ordinary conversation"}}]);
        await utimes(older,new Date("2026-01-01T00:00:00Z"),new Date("2026-01-01T00:00:00Z"));
        for(let i=0;i<125;i++)await transcript(home,`.codex/sessions/child-${i}.jsonl`,[{type:"session_meta",payload:{id,source:{subagent:{thread_spawn:{agent_path:`child-${i}`}}}}},{type:"response_item",payload:{type:"message",role:"user",content:"Hidden child"}}]);
        const found=await discoverLocalChats({home},new AbortController().signal);
        expect(found.sources.map(source=>source.title)).toEqual(["Older ordinary conversation"]);expect(found.limited).toBe(false);
    });
    it("honors abort and caps results while reporting an incomplete catalog", async () => {
        const home = await fixture();
        for(let i=0;i<5;i++) await transcript(home,`.claude/projects/project/${i}.jsonl`,[{type:"user",message:{content:`Chat ${i}`}}]);
        const result = await discoverLocalChats({home,maxCandidates:2},new AbortController().signal);
        expect(result.sources).toHaveLength(2);expect(result.limited).toBe(true);
        const controller=new AbortController();controller.abort();
        await expect(discoverLocalChats({home},controller.signal)).rejects.toHaveProperty("name","AbortError");
    });
});
