import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "citty";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatsCommand } from "../../src/cli/commands/chats.js";
import { resolveCliProfile } from "../../src/cli/profiles.js";
import * as chatFiles from "../../src/cli/chat-client.js";
vi.mock("../../src/cli/profiles.js",()=>({resolveCliProfile:vi.fn(async()=>({name:"review",gatewayUrl:"https://matrix.test/vm/review?runtime=review"}))}));
vi.mock("../../src/cli/auth-state.js",()=>({requireCliAuthToken:vi.fn(async()=>"private-token")}));
const detail={record:{chat:{id:"chat_test",ownerScope:{type:"personal",ownerId:"owner_test"},title:"Test",lifecycle:"active",attention:"none",revision:0,messageCount:0,createdAt:"2026-10-18T00:00:00.000Z",updatedAt:"2026-10-18T00:00:00.000Z"}},messages:[],turns:[],runs:[],activities:[]};
afterEach(()=>{vi.restoreAllMocks();process.exitCode=0;});
describe("Chat commands",()=>{
  it("does not report export success when interrupted during saving", async()=>{
    const output=vi.spyOn(console,"log").mockImplementation(()=>{});
    vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json(detail));
    vi.spyOn(chatFiles,"writeChatExport").mockImplementation(async()=>{process.emit("SIGINT");});
    await runCommand(chatsCommand,{rawArgs:["export","chat_test","--output","unused.json","--json"]});
    expect(process.exitCode).toBe(130); expect(output).not.toHaveBeenCalled();
  });
  it.each(["read","get"])("%s uses profile auth and prints a structured result",async command=>{
    const output=vi.spyOn(console,"log").mockImplementation(()=>{});
    const fetcher=vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json(detail));
    await runCommand(chatsCommand,{rawArgs:[command,"chat_test","--profile","review","--json"]});
    expect(resolveCliProfile).toHaveBeenCalledWith(expect.objectContaining({profile:"review"}));
    expect(output).toHaveBeenCalledWith(JSON.stringify({v:1,ok:true,data:{detail}}));
    expect(String(fetcher.mock.calls[0]![0])).toContain("/vm/review/api/chats/chat_test?runtime=review");
  });
  it("validates pagination options without sending requests",async()=>{
    const errors=vi.spyOn(console,"error").mockImplementation(()=>{});
    const fetcher=vi.spyOn(globalThis,"fetch");
    await runCommand(chatsCommand,{rawArgs:["read","chat_test","--limit","1e2","--json"]});
    expect(fetcher).not.toHaveBeenCalled();expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(errors.mock.calls[0]![0])).error.code).toBe("chat_invalid_input");
  });
  it("does not reveal server error payloads",async()=>{
    const errors=vi.spyOn(console,"error").mockImplementation(()=>{});
    vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("postgres://private-token@host/db",{status:500}));
    await runCommand(chatsCommand,{rawArgs:["read","chat_test","--json"]});
    expect(String(errors.mock.calls[0]![0])).not.toMatch(/postgres|private-token/);expect(process.exitCode).toBe(1);
  });
  it("exports valid JSON through the actual command without overwriting",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"chat-command-"));
    const path=join(dir,"chat.json");
    vi.spyOn(console,"log").mockImplementation(()=>{});
    vi.spyOn(console,"error").mockImplementation(()=>{});
    vi.spyOn(globalThis,"fetch").mockImplementation(async()=>Response.json(detail));
    try {
      await runCommand(chatsCommand,{rawArgs:["export","chat_test","--output",path,"--json"]});
      expect(JSON.parse(await readFile(path,"utf8"))).toMatchObject({version:1,detail});
      await runCommand(chatsCommand,{rawArgs:["export","chat_test","--output",path,"--json"]});
      expect(process.exitCode).toBe(1);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});
