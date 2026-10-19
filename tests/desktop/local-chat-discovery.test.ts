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
    it.each([
        {
            scenario: "saved custom title before an automatic summary",
            records: [{type:"custom-title",customTitle:"Saved <command-name> title"}, {type:"summary",summary:"Later automatic summary"}],
            expected: "Saved <command-name> title",
        },
        {
            scenario: "saved custom title after an automatic summary",
            records: [{type:"summary",summary:"Earlier automatic summary"}, {type:"custom-title",customTitle:"Saved title"}],
            expected: "Saved title",
        },
        {
            scenario: "latest custom title despite a newer automatic summary",
            records: [{type:"custom-title",customTitle:"Old saved title"}, {type:"summary",summary:"Earlier summary"}, {type:"custom-title",customTitle:"Latest saved title"}, {type:"summary",summary:"Latest automatic summary"}],
            expected: "Latest saved title",
        },
        {
            scenario: "latest summary when no custom title exists",
            records: [{type:"summary",summary:"Old automatic summary"}, {type:"summary",summary:"Latest automatic summary"}],
            expected: "Latest automatic summary",
        },
    ])("preserves Claude title precedence: $scenario", async ({records, expected}) => {
        const home = await fixture();
        await transcript(home, ".claude/projects/project/title-precedence.jsonl", [
            {type:"user",message:{content:"Original human prompt"}}, ...records,
        ]);
        const result = await discoverLocalChats({home}, new AbortController().signal);
        expect(result.sources.map(source => source.title)).toEqual([expected]);
    });
    it.each(["claude", "codex"] as const)("keeps a %s prompt spanning adjacent metadata reads", async (harness) => {
        const home = await fixture();
        const text = "Boundary prompt " + "x".repeat(80 * 1024);
        const record = harness === "claude" ? {type:"user",message:{content:text}}
            : {type:"response_item",payload:{role:"user",content:[{type:"input_text",text}]}};
        const relative = harness === "claude" ? ".claude/projects/project/boundary.jsonl" : ".codex/sessions/boundary.jsonl";
        await transcript(home, relative, [record]);
        const result = await discoverLocalChats({home}, new AbortController().signal);
        expect(result.sources.map(source => source.title)).toEqual([text.slice(0,160)]);
    });
    it("keeps explicit saved-title precedence when its record crosses the adjacent-read boundary", async () => {
        const home = await fixture();
        await transcript(home, ".claude/projects/project/saved-boundary.jsonl", [
            {type:"user",message:{content:"Original prompt"}},
            {type:"custom-title",padding:"x".repeat(80 * 1024),customTitle:"Saved garden conversation"},
        ]);
        const result = await discoverLocalChats({home}, new AbortController().signal);
        expect(result.sources.map(source => source.title)).toEqual(["Saved garden conversation"]);
    });
    it("decodes a multibyte title only after joining adjacent byte reads", async () => {
        const home = await fixture();
        const text = "🌻 Garden tasks";
        const record = {type:"user",message:{content:text}};
        const line = JSON.stringify(record);
        const prefixBytes = Buffer.byteLength(line.slice(0,line.indexOf("🌻")));
        const filler = {type:"assistant",padding:""};
        // The first byte of the four-byte flower is the final byte of the head read.
        filler.padding = "x".repeat(64 * 1024 - 1 - prefixBytes - Buffer.byteLength(JSON.stringify(filler)) - 1);
        await transcript(home, ".claude/projects/project/unicode-boundary.jsonl", [filler,record]);
        const result = await discoverLocalChats({home}, new AbortController().signal);
        expect(result.sources.map(source => source.title)).toEqual([text]);
    });
    it("still reads a complete tail prompt when a large record leaves a gap", async () => {
        const home = await fixture();
        await transcript(home, ".claude/projects/project/gapped-tail.jsonl", [
            {type:"assistant",padding:"x".repeat(160 * 1024)},
            {type:"user",message:{content:"Complete tail prompt"}},
        ]);
        const result = await discoverLocalChats({home}, new AbortController().signal);
        expect(result.sources.map(source => source.title)).toEqual(["Complete tail prompt"]);
    });
    it("never joins fragments separated by unread bytes into an invented prompt", async () => {
        const home = await fixture();
        await transcript(home, ".claude/projects/project/gap-only.jsonl", [
            {type:"user",message:{content:"Unread middle " + "x".repeat(160 * 1024)}},
        ]);
        const result = await discoverLocalChats({home}, new AbortController().signal);
        expect(result.sources.map(source => source.title)).toEqual(["Claude Code conversation gap-only"]);
    });
    it("uses the next human prompt after Claude command metadata, retaining saved-title precedence",async()=>{
        const home=await fixture();
        const command="<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>";
        const records=[{type:"user",message:{content:command}},{type:"assistant",message:{content:"Synthetic compacted reply"}},
            {type:"user",message:{content:[{type:"text",text:"Fix the import progress"}]}}];
        await transcript(home,".claude/projects/project/normal.jsonl",records);
        await transcript(home,".claude/projects/project/saved.jsonl",[...records,{type:"custom-title",customTitle:"My saved <command-name> title"}]);
        const result=await discoverLocalChats({home},new AbortController().signal);
        expect(result.sources.map(source=>source.title).sort()).toEqual(["Fix the import progress","My saved <command-name> title"]);
    });
    it("uses the existing fallback for command-only Claude history without removing ordinary tag discussion",async()=>{
        const home=await fixture();
        await transcript(home,".claude/projects/project/control.jsonl",[{type:"user",message:{content:"<command-name>/compact</command-name><command-message>compact</command-message>"}}]);
        const prose="Explain <command-name> tags in Claude transcripts";
        await transcript(home,".claude/projects/project/prose.jsonl",[{type:"user",message:{content:prose}}]);
        const result=await discoverLocalChats({home},new AbortController().signal);
        expect(result.sources.map(source=>source.title).sort()).toEqual(["Claude Code conversation control",prose]);
    });
    it.each([
        "# AGENTS.md instructions for /synthetic\n<INSTRUCTIONS>Project rules</INSTRUCTIONS>",
        "<environment_context>Synthetic environment</environment_context>",
        "<recommended_plugins>Tools</recommended_plugins>\n<environment_context>Synthetic environment</environment_context>",
        "<recommended_plugins>Tools</recommended_plugins>\n# AGENTS.md instructions for /synthetic\n<INSTRUCTIONS>Project rules</INSTRUCTIONS>",
    ])("uses the human prompt as the title after injected context: %s", async (context) => {
        const home = await fixture();
        await transcript(home, ".codex/sessions/conversation.jsonl", [
            {type:"session_meta",payload:{id:"019eb0ae-9a30-7541-bdb8-db4d17e65146",cwd:"/synthetic"}},
            {type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:context}]}},
            {type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"Fix the upload progress"}]}},
        ]);
        const result = await discoverLocalChats({home}, new AbortController().signal);
        expect(result.sources.map(source => source.title)).toEqual(["Fix the upload progress"]);
    });
    it("preserves an ordinary human prompt discussing instructions and ignores legacy injected context", async () => {
        const home = await fixture();
        await transcript(home, ".codex/sessions/legacy.jsonl", [
            {type:"UserMessage",content:"<environment_context>Synthetic setup</environment_context>"},
            {type:"UserMessage",content:"Explain # AGENTS.md instructions and <environment_context> tags"},
        ]);
        const result = await discoverLocalChats({home}, new AbortController().signal);
        expect(result.sources.map(source => source.title)).toEqual(["Explain # AGENTS.md instructions and <environment_context> tags"]);
    });
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
