// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createBotClient } from "../../packages/ui/src/chat-agents/bots/client";
import { ChatAgentsWorkspace } from "@matrix-os/ui";
import { RenameableConversationRow } from "../../shell/src/components/chat/ChatTitleRename";
import { WebChatSearchDialog } from "../../shell/src/components/chat/WebChatSearchDialog";
import { useGlobalShortcuts } from "../../shell/src/hooks/useGlobalShortcuts";
import { CanvasWindow } from "../../shell/src/components/canvas/CanvasWindow";
import { ChatProvider } from "../../shell/src/stores/chat-context";
import { ChatApp } from "../../shell/src/components/ChatApp";
import { useWebChatRailOrder } from "../../shell/src/components/chat/useWebChatRailOrder";
import { clientFixture } from "../desktop/chat-agents-fixture";
vi.mock("@clerk/nextjs",async original=>({...await original<typeof import("@clerk/nextjs")>(),useOrganization:()=>({organization:null}),useAuth:()=>({userId:null,sessionId:null})}));
vi.mock("../../shell/src/components/chat/SharedWithMeNav",()=>({SharedWithMeNav:({onOpen}:{onOpen():void})=><button onClick={onOpen}>Shared with me</button>}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it("shows Web search without filter or sorting controls",async()=> {
  vi.stubGlobal("ResizeObserver",class {observe(){} unobserve(){} disconnect(){}});
  const client = clientFixture();
  vi.stubGlobal("fetch",vi.fn(async()=>Response.json(await client.catalog())));
  await act(async()=>{render(<ChatApp messages={[]} busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} agentClient={client}/>);await Promise.resolve();});
  fireEvent.click(screen.getByRole("button", {name:"Search chats"}));
  const search = screen.getByRole("combobox", {name:"Search chats"});
  fireEvent.change(search, {target:{value:"test"}});
  expect((search as HTMLInputElement).value).toBe("test");
  expect(screen.queryByRole("button",{name:"Sort chats"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Unread"})).toBeNull();
});
it("keeps Web manual order in the current client and rejects stale identity callbacks",()=> {
  const items=[{id:"a",preview:"A",messageCount:1,updatedAt:1},{id:"b",preview:"B",messageCount:1,updatedAt:2}];
  const first={}; const second={};
  const hook=renderHook(({client})=>useWebChatRailOrder(items,client),{initialProps:{client:first}});
  expect(hook.result.current.chats.map(item=>item.id)).toEqual(["b","a"]);
  act(()=>hook.result.current.setMode("manual"));
  const stale=hook.result.current.move;
  act(()=>hook.result.current.move("chat","a","b"));
  expect(hook.result.current.chats.map(item=>item.id)).toEqual(["a","b"]);
  const oldScope=hook.result.current.scopeKey;
  hook.rerender({client:second});
  expect(hook.result.current.mode).toBe("lastUpdated");
  expect(hook.result.current.scopeKey).not.toBe(oldScope);
  act(()=>stale("chat","a","b"));
  expect(hook.result.current.chats.map(item=>item.id)).toEqual(["b","a"]);
  hook.rerender({client:first});
  act(()=>hook.result.current.setMode("manual"));
  act(()=>stale("chat","a","b"));
  expect(hook.result.current.chats.map(item=>item.id)).toEqual(["b","a"]);
});
it('preserves unrelated manual positions when moving within a project subset',()=>{
 const items=['a','b','c','d'].map((id,index)=>({id,preview:id,messageCount:1,updatedAt:4-index}));const client={};
 const hook=renderHook(()=>useWebChatRailOrder(items,client));
 act(()=>hook.result.current.setMode('manual'));
 act(()=>hook.result.current.move('chat','d','b',['b','d']));
 expect(hook.result.current.manualIds).toEqual(['a','d','b','c']);
});
it('admits newly paged IDs into the bounded manual preference without evicting the active group',()=>{
 const items=Array.from({length:1000},(_,index)=>({id:`chat_${index}`,preview:'Chat',messageCount:1,updatedAt:1000-index}));const client={};
 const hook=renderHook(()=>useWebChatRailOrder(items,client));
 act(()=>hook.result.current.setMode('manual'));
 act(()=>hook.result.current.move('chat','chat_new','chat_0',['chat_new','chat_0']));
 expect(hook.result.current.manualIds?.length).toBeLessThanOrEqual(1000);
 expect(hook.result.current.manualIds?.slice(0,2)).toEqual(['chat_0','chat_new']);
});
it('uses the displayed group order for the first manual move when automatic server order differs',()=>{
 const items=['a','b','c','d'].map((id,index)=>({id,preview:id,messageCount:1,updatedAt:4-index}));const client={};
 const hook=renderHook(()=>useWebChatRailOrder(items,client));
 act(()=>hook.result.current.move('chat','b','d',['d','b']));
 expect(hook.result.current.mode).toBe('manual');
 expect(hook.result.current.manualIds).toEqual(['a','b','c','d']);
});
it('rejects a stale reorder whose target has left the visible group',()=>{
 const items=['a','b'].map((id,index)=>({id,preview:id,messageCount:1,updatedAt:2-index}));const client={};
 const hook=renderHook(()=>useWebChatRailOrder(items,client));
 act(()=>hook.result.current.move('chat','b','a',['b']));
 expect(hook.result.current.mode).toBe('lastUpdated');
});
it('preserves untouched visible rows when the first server-page move differs from global timestamp order',()=>{
 const items=['c','a','b'].map((id,index)=>({id,preview:id,messageCount:1,updatedAt:3-index})); const client={};
 const hook=renderHook(()=>useWebChatRailOrder(items,client));
 act(()=>hook.result.current.move('chat','a','b',['a','b','c']));
 expect(hook.result.current.manualIds).toEqual(['b','a','c']);
});
it("keeps legacy conversations visible when an update timestamp is outside the Date range",()=> {
  const items=[{id:"invalid",preview:"Invalid date",messageCount:1,updatedAt:1e30},{id:"valid",preview:"Valid date",messageCount:1,updatedAt:2}];
  const client={};
  const hook=renderHook(()=>useWebChatRailOrder(items,client));
  expect(hook.result.current.chats.map(item=>item.id)).toEqual(["valid","invalid"]);
});

it.each(["keyboard", "drag"])("starts Web manual ordering with a direct %s move without Search sorting", async action => {
  vi.stubGlobal("ResizeObserver",class {observe(){} unobserve(){} disconnect(){}});
  const client=clientFixture();
  vi.stubGlobal("fetch",vi.fn(async()=>Response.json(await client.catalog())));
  const items=[{id:"a",preview:"A",messageCount:1,updatedAt:1},{id:"b",preview:"B",messageCount:1,updatedAt:2}];
  const select=vi.fn();
  await act(async()=>{render(<ChatApp messages={[]} busy={false} connected conversations={items} onNewChat={vi.fn()} onSwitchConversation={select} onSubmit={vi.fn()} agentClient={client}/>);await Promise.resolve();});
  const doneHeader = screen.getByRole("button", { name: "Done" });
  expect(doneHeader.getAttribute("aria-expanded")).toBe("true");
  await screen.findByRole("button", { name: "B", exact: true });
  expect(screen.getByRole("button", { name: "A", exact: true })).toBeTruthy();
  const row=(id:string)=>document.querySelector<HTMLElement>(`[data-rail-order-id="${id}"]`)!;
  const ids=()=>[...document.querySelectorAll<HTMLElement>("[data-rail-order-id]")].map(e=>e.dataset.railOrderId);
  expect(ids()).toEqual(["b","a"]);
  expect(screen.queryByRole("button",{name:"Sort chats"})).toBeNull();
  if(action==="keyboard")fireEvent.keyDown(screen.getByRole("button",{name:"B",exact:true}),{key:"ArrowDown",altKey:true});
  else {
    const values=new Map<string,string>();
    const transfer={effectAllowed:"",dropEffect:"",types:["application/x-matrix-chat-rail"],setData:(key:string,value:string)=>values.set(key,value),getData:(key:string)=>values.get(key)??""};
    fireEvent.dragStart(row("b"),{dataTransfer:transfer});
    fireEvent.drop(row("a"),{dataTransfer:transfer});
  }
  await waitFor(()=>expect(ids()).toEqual(["a","b"]));
  expect(doneHeader.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "A", exact: true })).toBeTruthy();
  expect(select).not.toHaveBeenCalled();
});
it("rejects invalid Web moves before entering manual order",()=>{
  const client={};const items=[{id:"a",preview:"A",messageCount:1,updatedAt:1},{id:"b",preview:"B",messageCount:1,updatedAt:2}];
  const hook=renderHook(()=>useWebChatRailOrder(items,client));
  act(()=>hook.result.current.move("chat","a","missing"));
  act(()=>hook.result.current.move("chat","a","a"));
  act(()=>hook.result.current.move("project","a","b"));
  expect(hook.result.current.mode).toBe("lastUpdated");
  act(()=>hook.result.current.move("chat","a","b"));
  expect(hook.result.current.mode).toBe("manual");
  expect(hook.result.current.chats.map(item=>item.id)).toEqual(["a","b"]);
});
it("opens the full archive page from Search and keeps its own search bar", async () => {
  vi.stubGlobal("ResizeObserver",class {observe(){} unobserve(){} disconnect(){}});
  const client=clientFixture();
  vi.stubGlobal("fetch",vi.fn(async()=>Response.json(await client.catalog())));
  const archiveClient={list:vi.fn(async()=>({items:[]})),search:vi.fn(async()=>({items:[]})),updateLifecycle:vi.fn(),delete:vi.fn()};
  await act(async()=>{render(<ChatApp messages={[]} busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} agentClient={client} archiveClient={archiveClient}/>);await Promise.resolve();});
  expect(screen.queryByRole("button",{name:"Archived chats"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Search chats"}));
  fireEvent.click(screen.getByRole("tab",{name:"Archived",exact:true}));
  fireEvent.click(screen.getByRole("button",{name:"Open the archived list"}));
  expect(screen.queryByRole("dialog",{name:"Archived chats"})).toBeNull();
  expect(screen.getByRole("region",{name:"Archived chats"})).toBeTruthy();
  expect(screen.getByRole("searchbox",{name:"Search archived chats"})).toBeTruthy();
  expect(screen.queryByRole("combobox",{name:"Search chats"})).toBeNull();
});
it("provides Pin and Move to project in a chat row menu", async () => {
 const pin=vi.fn(),move=vi.fn();
 render(<RenameableConversationRow conversation={{id:"chat_menu",title:"Menu chat",preview:"",messageCount:1,updatedAt:1}} active={false} mobile={false} editing={false} renamePending={false} onSelect={vi.fn()} onRenameCommit={vi.fn()} onRenameCancel={vi.fn()} onPin={pin} moveItems={[{label:"Matrix OS",onSelect:move}]}/>);
 fireEvent.pointerDown(screen.getByRole("button",{name:"Actions for Menu chat"}),{button:0,ctrlKey:false});
 fireEvent.click(await screen.findByRole("menuitem",{name:"Pin",exact:true}));expect(pin).toHaveBeenCalledOnce();
 fireEvent.pointerDown(screen.getByRole("button",{name:"Actions for Menu chat"}),{button:0,ctrlKey:false});
 fireEvent.keyDown(await screen.findByRole("menuitem",{name:/Move to project/}),{key:"ArrowRight"});
 fireEvent.click(await screen.findByRole("menuitem",{name:"Matrix OS",exact:true}));expect(move).toHaveBeenCalledOnce();
});
it("archives the selected idle chat with the displayed desktop shortcut", async () => {
  vi.stubGlobal("ResizeObserver",class {observe(){} unobserve(){} disconnect(){}});
  const client=clientFixture();vi.stubGlobal("fetch",vi.fn(async()=>Response.json(await client.catalog())));
  const archive=vi.fn(async()=>({chatId:"chat_shortcut",revision:2}));
  await act(async()=>{render(<ChatApp messages={[]} sessionId="chat_shortcut" busy={false} connected conversations={[{id:"chat_shortcut",title:"Shortcut chat",preview:"",messageCount:1,updatedAt:1}]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} onArchiveConversation={archive} agentClient={client}/>);await Promise.resolve();});
  fireEvent.keyDown(window,{key:"a",metaKey:true,shiftKey:true});
  await waitFor(()=>expect(archive).toHaveBeenCalledWith("chat_shortcut"));
});
it.each([false,true])("keeps the read-state action available in the Web row menu (unread=%s)", async unread=>{
 const toggle=vi.fn();
 render(<RenameableConversationRow conversation={{id:"chat_read",title:"Read chat",preview:"",messageCount:1,updatedAt:1,readState:{unread,version:1,latestIncomingSeq:1,readThroughSeq:0,markedUnread:unread}}} active={false} mobile={false} editing={false} renamePending={false} onSelect={vi.fn()} onRenameCommit={vi.fn()} onRenameCancel={vi.fn()} onToggleRead={toggle}/>);
 fireEvent.pointerDown(screen.getByRole("button",{name:"Actions for Read chat"}),{button:0,ctrlKey:false});
 fireEvent.click(await screen.findByRole("menuitem",{name:unread?"Mark as read":"Mark as unread",exact:true}));
 expect(toggle).toHaveBeenCalledOnce();
});
it("keeps archive navigation visible when Search was opened with the sidebar collapsed", async()=>{
 vi.stubGlobal("ResizeObserver",class{observe(){}unobserve(){}disconnect(){}});
 vi.stubGlobal("fetch",vi.fn(async()=>Response.json({projects:[]})));
 const api={list:vi.fn(async()=>({items:[]})),search:vi.fn(),updateLifecycle:vi.fn(),delete:vi.fn()};
 function Harness(){useGlobalShortcuts(()=>{},false);return <ChatApp messages={[]} busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} archiveClient={api}/>;}
 render(<Harness/>);
 fireEvent.click(screen.getByRole("button",{name:"Close Chat sidebar"}));
 fireEvent.keyDown(window,{key:"k",metaKey:true});
 fireEvent.click(screen.getByRole("tab",{name:"Archived",exact:true}));fireEvent.click(screen.getByRole("button",{name:"Open the archived list"}));
 fireEvent.click(screen.getByRole("button",{name:"Open Chat sidebar"}));
 expect(screen.getByRole("button",{name:"Search chats"})).toBeTruthy();
});
it("continues search history past 500 results while retaining a bounded visible window", async()=>{
 let page=0;
 const api={list:vi.fn(async()=>{const start=page++*50;return{items:Array.from({length:50},(_,i)=>({chat:{id:`chat_${start+i}`,title:`Archive ${start+i}`,revision:1,lifecycle:"archived",updatedAt:"2026-11-17T00:00:00Z",createdAt:"2026-11-17T00:00:00Z"}})),nextCursor:`cursor_${page}`};}),search:vi.fn(),updateLifecycle:vi.fn(),delete:vi.fn()};
 render(<WebChatSearchDialog client={api as never} recent={[]} projects={[]} onClose={vi.fn()} onSelect={vi.fn()} onProject={vi.fn()} onOpenArchived={vi.fn()}/>);
 fireEvent.click(screen.getByRole("tab",{name:"Archived",exact:true}));await screen.findByText("Archive 49");
 // Reuse the live control instead of rescanning the growing result tree on every page.
 const showMore=screen.getByRole("button",{name:"Show more"});
 for(let i=1;i<=10;i++){fireEvent.click(showMore);await screen.findByText(`Archive ${i*50+49}`);}
 expect(api.list).toHaveBeenCalledTimes(11);expect(screen.queryByText("Archive 0")).toBeNull();
 expect(screen.getAllByRole("option")).toHaveLength(500);
},60000);
it("keeps Search inside a smaller Web window instead of clipping its right edge",()=>{
 render(<WebChatSearchDialog centerX={490} bounds={{left:0,right:740}} recent={[]} projects={[]} onClose={vi.fn()} onSelect={vi.fn()} onProject={vi.fn()} onOpenArchived={vi.fn()}/>);
 expect(screen.getByRole('dialog',{name:'Search chats'}).style.left).toBe('424px');
});
it.each(["Projects", "Shared"])("finishes local %s filtering without an unissued chat search", scope => {
  const search = vi.fn();
  render(<WebChatSearchDialog search={search} onShared={vi.fn()} recent={[]} projects={[{id:"proj_local",slug:"local",name:"Local project"}]} onClose={vi.fn()} onSelect={vi.fn()} onProject={vi.fn()} onOpenArchived={vi.fn()}/>);
  fireEvent.click(screen.getByRole("tab",{name:scope,exact:true}));
  fireEvent.change(screen.getByRole("combobox",{name:"Search chats"}),{target:{value:"Local"}});
  expect(screen.queryByText("Searching all chats…")).toBeNull();
  expect(search).not.toHaveBeenCalled();
  if(scope==="Projects") expect(screen.getByRole("option",{name:/Local project/})).toBeTruthy();
});
it.each(['Agents','Schedules','Shared with me','Shared from Search'])('leaves the archive when opening %s',async destination=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
 const client={...clientFixture(),bots:createBotClient(async()=>{throw new Error('ScheduleFixtureUnavailable');})};vi.stubGlobal('fetch',vi.fn(async()=>Response.json(await client.catalog())));
 const shared=vi.fn();const api={list:vi.fn(async()=>({items:[]})),search:vi.fn(),updateLifecycle:vi.fn(),delete:vi.fn()};
 render(<ChatAgentsWorkspace><ChatApp messages={[]} busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} agentClient={client} archiveClient={api} onOpenSharedHome={shared}/></ChatAgentsWorkspace>);
 await screen.findByRole("button",{name:"Agents",exact:true});
 fireEvent.click(screen.getByRole('button',{name:'Search chats'}));fireEvent.click(screen.getByRole('tab',{name:'Archived',exact:true}));fireEvent.click(screen.getByRole('button',{name:'Open the archived list'}));
 expect(screen.getByRole('region',{name:'Archived chats'})).toBeTruthy();
 if(destination==='Shared from Search'){
  fireEvent.click(screen.getByRole('button',{name:'Search chats'}));fireEvent.click(screen.getByRole('tab',{name:'Shared',exact:true}));
  fireEvent.click(screen.getByRole('button',{name:'Shared with me',exact:true}));
 }else fireEvent.click(screen.getByRole('button',{name:destination,exact:true}));
 expect(screen.queryByRole('region',{name:'Archived chats'})).toBeNull();
 if(destination.startsWith('Shared'))expect(shared).toHaveBeenCalledOnce();
});
it.each(['keyboard','drag'])('reorders independently paged status and project rows using %s, including chats outside the initial rail',async action=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({projects:[{id:'proj_local',slug:'local',name:'Local project'}]})));
 const items=['a','b'].map(id=>({chat:{id,title:id.toUpperCase(),revision:1,lifecycle:'active',attention:'none',messageCount:1,createdAt:'2026-11-17T00:00:00Z',updatedAt:'2026-11-17T00:00:00Z'},projectId:'proj_local',readState:{unread:false,markedUnread:false,readThroughSeq:0},classification:'done'}));
 const load=vi.fn(async({group}:{group:string})=>({items:group==='done'||group==='project'?items:[],totalCount:group==='done'||group==='project'?2:0}));
 render(<ChatApp messages={[]} busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} loadNavigationPage={load as never}/>);
 const done=await screen.findByRole('region',{name:'Done'});
 await within(done).findByRole('button',{name:'B',exact:true});
 fireEvent.click(await screen.findByRole('button',{name:'Expand Local project chats'}));
 const projects=screen.getByRole('navigation',{name:'Projects'});await within(projects).findByRole('button',{name:'B',exact:true});
 const ids=(root:HTMLElement)=>[...root.querySelectorAll<HTMLElement>('[data-rail-order-kind="chat"]')].map(row=>row.dataset.railOrderId);
 expect(ids(done)).toEqual(['a','b']);
 if(action==='keyboard')fireEvent.keyDown(within(done).getByRole('button',{name:'B',exact:true}),{key:'ArrowUp',altKey:true});
 else{const values=new Map<string,string>();const dataTransfer={effectAllowed:'',dropEffect:'',types:['application/x-matrix-chat-rail'],setData:(key:string,value:string)=>values.set(key,value),getData:(key:string)=>values.get(key)??''};fireEvent.dragStart(done.querySelector('[data-rail-order-id="b"]')!,{dataTransfer});fireEvent.drop(done.querySelector('[data-rail-order-id="a"]')!,{dataTransfer});}
 await waitFor(()=>expect(ids(done)).toEqual(['b','a']));
 expect(ids(projects)).toEqual(['b','a']);
});
it.each(["Chats", "All"])("finds restored chats in %s first and subsequent search pages without reopening", async scope => {
  const archived = { chat: { id: "chat_restored", title: "Restored answer", revision: 1, lifecycle: "archived" as const,
    attention: "none" as const, messageCount: 1, createdAt: "2026-11-17T00:00:00Z", updatedAt: "2026-11-17T00:00:00Z" } };
  const active = { ...archived, chat: { ...archived.chat, revision: 2, lifecycle: "active" as const } };
  const other = { ...active, chat: { ...active.chat, id: "chat_other", title: "Other result" } };
  const api = { list: vi.fn(async () => ({ items: [archived], nextCursor: "cursor_archived" })),
    updateLifecycle: vi.fn(async () => active), delete: vi.fn() };
  const search = vi.fn(async (_query: string, input?: {cursor?: string}) => input?.cursor
    ? {items:[active]} : {items:[other, active],nextCursor:"cursor_search"});
  render(<WebChatSearchDialog client={api as never} search={search} recent={[]} projects={[]}
    onClose={vi.fn()} onSelect={vi.fn()} onProject={vi.fn()} onOpenArchived={vi.fn()}/>);
  fireEvent.click(screen.getByRole("tab",{name:"Archived",exact:true}));
  fireEvent.click(await screen.findByRole("button",{name:"Restore Restored answer"}));
  await waitFor(()=>expect(screen.queryByRole("button",{name:"Restore Restored answer"})).toBeNull());
  fireEvent.click(screen.getByRole("button",{name:"Show more"}));
  await waitFor(()=>expect(api.list).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Restored answer")).toBeNull();
  fireEvent.click(screen.getByRole("tab",{name:scope,exact:true}));
  fireEvent.change(screen.getByRole("combobox",{name:"Search chats"}),{target:{value:"answer"}});
  expect(await screen.findByText("Restored answer")).toBeTruthy();
  // A new query with the restored Chat only on its second page must also find it.
  search.mockImplementation(async (_query, input) => input?.cursor ? {items:[active]} : {items:[other],nextCursor:"cursor_search"});
  fireEvent.change(screen.getByRole("combobox",{name:"Search chats"}),{target:{value:"second query"}});
  await waitFor(()=>expect(search).toHaveBeenLastCalledWith("second query",expect.anything()));
  await waitFor(()=>expect(screen.queryByText("Restored answer")).toBeNull());
  fireEvent.click(screen.getByRole("button",{name:"Show more"}));
  expect(await screen.findByText("Restored answer")).toBeTruthy();
});
it("updates an older paged Canvas chat read mark through the real window and ChatApp", async () => {
  vi.stubGlobal("ResizeObserver", class { observe(){} unobserve(){} disconnect(){} });
  const client = clientFixture();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(await client.catalog())));
  const row = { chat: { id: "chat_canvas_old", title: "Older Canvas chat", lifecycle: "active", attention: "none", revision: 1,
    messageCount: 2, createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z" },
    readState: { version: 1, readThroughSeq: 0, latestIncomingSeq: 2, markedUnread: false, unread: true } };
  const navigationPage = vi.fn(async ({ group }: { group: string }) => ({ items: group === "done" ? [row] : [], totalCount: group === "done" ? 1 : 0 }));
  const chat = { messages: [], busy: false, connected: true, conversations: [], newChat: vi.fn(), switchConversation: vi.fn(),
    submitMessage: vi.fn(), agentClient: client, navigationPage, chatReadStateUpdates: [] };
  const win = { id: "canvas-read-regression", path: "__chat__", title: "Chat", x: 0, y: 0, width: 1000, height: 700, minimized: false, zIndex: 1 };
  const view = render(<ChatProvider value={chat as never}><CanvasWindow win={win}/></ChatProvider>);
  expect(await screen.findByLabelText("Unread Older Canvas chat")).toBeTruthy();
  const updated = { ...row, readState: { ...row.readState, version: 2, readThroughSeq: 2, unread: false } };
  view.rerender(<ChatProvider value={{ ...chat, chatReadStateUpdates: [updated] } as never}><CanvasWindow win={win}/></ChatProvider>);
  await waitFor(() => expect(screen.queryByLabelText("Unread Older Canvas chat")).toBeNull());
  expect(screen.getByRole("button", { name: "Older Canvas chat", exact: true })).toBeTruthy();
});

it('centers Web Search over the conversation while an inspector is open',()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({projects:[]})));
 const measure=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(){
  if(this.classList.contains('chat-web-design'))return new DOMRect(0,0,1512,982);
  if(this.tagName==='MAIN')return new DOMRect(240,0,872,982);
  return new DOMRect();
 });
 try{render(<ChatApp messages={[]} sessionId="chat_center" busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} sideChatClient={{getSideChat:vi.fn(),createSideChat:vi.fn(),askSideChat:vi.fn()}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Toggle chat inspector'}));fireEvent.click(screen.getByRole('button',{name:'Search chats'}));expect(screen.getByRole('dialog',{name:'Search chats'}).style.left).toBe('676px');
 }finally{measure.mockRestore();}
});
