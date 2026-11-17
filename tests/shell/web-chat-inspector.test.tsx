// @vitest-environment jsdom
import React from "react";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectManager } from "../../packages/gateway/src/project-manager";
import { createCodingAgentFilePreviewWiring } from "../../packages/gateway/src/coding-agents/file-preview-wiring";
import { createFilePreviewRoutes } from "../../packages/gateway/src/file-preview-routes";
import { fileSearch } from "../../packages/gateway/src/file-search";
import { Hono } from "hono";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWebChatInspector, type WebChatInspectorProps } from "../../shell/src/components/chat/useWebChatInspector";
import { ChatApp } from "../../shell/src/components/ChatApp";
import { WebChatInspector } from "../../shell/src/components/chat/WebChatInspector";

const terminalProps = vi.hoisted(() => vi.fn());
vi.mock("../../shell/src/components/terminal/TerminalPane", () => ({ TerminalPane: (props: unknown) => { terminalProps(props); return <div>Connected terminal</div>; } }));
vi.mock("../../shell/src/hooks/useTheme", () => ({ useTheme: () => ({}) }));

vi.mock("@clerk/nextjs",()=>({useOrganization:()=>({organization:null}),useAuth:()=>({userId:null,sessionId:null})}));
vi.mock("../../shell/src/components/chat-provider-onboarding",()=>({ChatProviderOnboarding:({children}:{children:React.ReactNode})=><>{children}</>}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
it('reveals a selected file through an ancestor beyond the first directory window', async () => {
 const entries=Array.from({length:1002},(_,index)=>({name:`folder_${index.toString().padStart(4,'0')}`,type:'directory'}));
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json({entries:url.includes('path=folder_1001')?[{name:'preview.txt',type:'file'}]:entries})));
 render(<WebChatInspector {...inspectorProps({filePath:'folder_1001/preview.txt'})}/>);
 expect((await screen.findByRole('treeitem',{name:'preview.txt'})).getAttribute('aria-selected')).toBe('true');
});
it('searches unopened project folders through the bounded Gateway file search', async () => {
 const homePath=await realpath(await mkdtemp(join(tmpdir(),'eng461-file-search-')));
 try {
  await mkdir(join(homePath,'projects/preview/repo/src'),{recursive:true});
  await writeFile(join(homePath,'projects/preview/repo/src/preview.txt'),'Preview');
  const app=new Hono().get('/api/files/search',async c=>c.json(await fileSearch(homePath,{q:c.req.query('q')!,path:c.req.query('path'),limit:Number(c.req.query('limit'))})));
  const request=vi.fn(async(url:string)=>{
   const parsed=new URL(url);
   if(parsed.pathname.endsWith('/files/search'))return app.request(parsed.pathname+parsed.search);
   if(parsed.pathname.endsWith('/files-location'))return Response.json({path:'projects/preview/repo'});
   return Response.json({entries:[{name:'src',type:'directory'}]});
  }); vi.stubGlobal('fetch',request);
  const open=vi.fn();
  render(<WebChatInspector {...inspectorProps({project:{id:'project_preview',slug:'preview'},onFilePathChange:open})}/>);
  await screen.findByRole('treeitem',{name:'src'});
  fireEvent.click(screen.getByRole('button',{name:'Filter files'}));
  fireEvent.change(screen.getByRole('searchbox',{name:'Filter files'}),{target:{value:'preview.txt'}});
  fireEvent.click(await screen.findByRole('button',{name:'Open search result src/preview.txt'}));
  expect(open).toHaveBeenCalledWith('src/preview.txt');
  expect(request.mock.calls.some(([url])=>{const parsed=new URL(url);return parsed.pathname.endsWith('/files/search')&&parsed.searchParams.get('path')==='projects/preview/repo'&&Number(parsed.searchParams.get('limit'))<=500;})).toBe(true);
 } finally {cleanup();await rm(homePath,{recursive:true,force:true});}
});
it('does not offer an unavailable desktop inspector on phones',()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({entries:[]})));
 render(<ChatApp mobile messages={[]} sessionId="chat_mobile" busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} sideChatClient={inspectorProps().sideChatClient}/>);
 expect(screen.queryByRole('button',{name:'Toggle chat inspector'})).toBeNull();
});

it("covers the chat pane in a narrow floating window instead of leaving an unusable sliver", () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ entries: [] })));
  render(<WebChatInspector chatId="chat_one" gatewayUrl="http://localhost:4000" layoutKey={null} rootWidth={768} railWidth={260}
    filePath={null} onFilePathChange={vi.fn()} terminalSessionIds={[]}
    sideChatClient={{ getSideChat: vi.fn(), createSideChat: vi.fn(), askSideChat: vi.fn() }} onSendToMain={vi.fn()} onClose={vi.fn()}/>);
  const inspector = screen.getByRole("complementary", { name: "Chat inspector" });
  expect(inspector.className).toContain("absolute");
  expect(inspector.style.width).toBe("508px");
  expect(screen.getByRole("button", { name: "Close inspector" })).toBeTruthy();
});

it("asks before stopping an active terminal and keeps it running when canceled", async () => {
  const workspaceId = `tws_${"a".repeat(32)}`;
  const tabId = `tt_${"b".repeat(32)}`;
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response("{}", { status: 200 });
    if (_url.endsWith("/api/terminal/workspaces")) return Response.json({ workspaces: [{ id: workspaceId, tabs: [{ id: tabId }] }] });
    return new Response(JSON.stringify({ entries: [] }), { status: 200 });
  });
  vi.stubGlobal("fetch", request);
  render(<WebChatInspector chatId="chat_one" gatewayUrl="http://localhost:4000" layoutKey={null} rootWidth={1200} railWidth={260}
    filePath={null} onFilePathChange={vi.fn()} terminalSessionIds={[`${workspaceId}:${tabId}`]}
    sideChatClient={{ getSideChat: vi.fn(), createSideChat: vi.fn(), askSideChat: vi.fn() }} onSendToMain={vi.fn()} onClose={vi.fn()}/>);
  fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
  expect(await screen.findByText("Connected terminal")).toBeTruthy();
  expect(terminalProps).toHaveBeenCalledWith(expect.objectContaining({ chatId: "chat_one" }));
  fireEvent.click(screen.getByRole("button", { name: "Close Terminal tab" }));
  expect(screen.getByRole("alertdialog", { name: "Stop this terminal?" }).getAttribute("data-slot")).toBe("dialog-content");
  expect(request.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("Connected terminal")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close Terminal tab" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop terminal" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith(
    `http://localhost:4000/api/terminal/workspaces/${workspaceId}/tabs/${tabId}`,
    expect.objectContaining({ method: "DELETE" }),
  ));
  await waitFor(() => expect(screen.getByRole("tabpanel", { name: "Files" })).toBeTruthy());
  expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
  expect(screen.queryByText("Connected terminal")).toBeNull();
});

it("ignores a saved terminal binding after its runtime tab was deleted", async () => {
  const workspaceId = `tws_${"a".repeat(32)}`;
  const tabId = `tt_${"b".repeat(32)}`;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/api/terminal/workspaces")
    ? Response.json({ workspaces: [{ id: workspaceId, tabs: [] }] })
    : Response.json({ entries: [] })));
  render(<WebChatInspector chatId="chat_one" gatewayUrl="http://localhost:4000" layoutKey={null} rootWidth={1200} railWidth={260}
    filePath={null} onFilePathChange={vi.fn()} terminalSessionIds={[`${workspaceId}:${tabId}`]}
    sideChatClient={{ getSideChat: vi.fn(), createSideChat: vi.fn(), askSideChat: vi.fn() }} onSendToMain={vi.fn()} onClose={vi.fn()}/>);
  fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("http://localhost:4000/api/terminal/workspaces", expect.anything()));
  expect(screen.queryByText("Connected terminal")).toBeNull();
  expect(screen.getByRole("button", { name: "New terminal" })).toBeTruthy();
});

it("opens a folder with more than 1,000 files using a bounded visible window", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url:string) => Response.json(url.includes("/files/search?") ? {results:[{name:"file_0000",path:"file_0000",type:"file"}],truncated:false} : { entries: Array.from({ length: 1002 }, (_, index) => ({ name: `file_${index.toString().padStart(4,"0")}`, type: "file" })) })));
  render(<WebChatInspector chatId="chat_one" gatewayUrl="http://localhost:4000" layoutKey={null} rootWidth={1200} railWidth={260}
    filePath={null} onFilePathChange={vi.fn()} terminalSessionIds={[]}
    sideChatClient={{ getSideChat: vi.fn(), createSideChat: vi.fn(), askSideChat: vi.fn() }} onSendToMain={vi.fn()} onClose={vi.fn()}/>);
  expect(await screen.findByRole("treeitem", { name: "file_0000" })).toBeTruthy();
  expect(screen.getAllByRole("treeitem")).toHaveLength(1000);
  expect(screen.getByRole("button",{name:"Next files in Home"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Next files in Home"}));
  await screen.findByRole("treeitem",{name:"file_1001"});
  expect(screen.getAllByRole("treeitem")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button",{name:"Filter files"}));
  fireEvent.change(screen.getByRole("searchbox",{name:"Filter files"}),{target:{value:"file_0000"}});
  expect(await screen.findByRole("button",{name:"Open search result file_0000"})).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not reuse a previous folder's entries while the next folder loads", async () => {
  let finishFolder: (response: Response) => void = () => {};
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("path=folder")
    ? new Promise<Response>(resolve => { finishFolder = resolve; })
    : Response.json({ entries: [{ name: "folder", type: "directory" }] })));
  render(<WebChatInspector chatId="chat_one" gatewayUrl="http://localhost:4000" layoutKey={null} rootWidth={1200} railWidth={260}
    filePath={null} onFilePathChange={vi.fn()} terminalSessionIds={[]}
    sideChatClient={{ getSideChat: vi.fn(), createSideChat: vi.fn(), askSideChat: vi.fn() }} onSendToMain={vi.fn()} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("treeitem", { name: "folder" }));
  expect(screen.getByRole("treeitem", { name: "folder" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.queryByRole("treeitem", { name: "old-child" })).toBeNull();
  finishFolder(Response.json({ entries: [] }));
  await waitFor(() => expect(screen.queryByRole("status", { name: /Loading files/ })).toBeNull());
});


it("opens a New tab picker, then preserves Files while adding Side chat", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ entries: [] })));
  const sideChatClient = { getSideChat: vi.fn(async () => ({threadId:null,messages:[]})), createSideChat: vi.fn(), askSideChat: vi.fn() };
  render(<WebChatInspector chatId="chat_picker" gatewayUrl="http://localhost:4000" layoutKey={null} rootWidth={1512} railWidth={240}
    filePath={null} onFilePathChange={vi.fn()} terminalSessionIds={[]} sideChatClient={sideChatClient} onSendToMain={vi.fn()} onClose={vi.fn()}/>);
  expect(screen.queryByRole("tab", {name:"Side chat"})).toBeNull();
  fireEvent.click(screen.getByRole("button", {name:"Add inspector tab"}));
  expect(screen.getByRole("tabpanel", {name:"New tab"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name:/Side chat/}));
  expect(screen.getByRole("tab", {name:"Files"})).toBeTruthy();
  expect(screen.getByRole("tab", {name:"Side chat"}).getAttribute("aria-selected")).toBe("true");
  await screen.findByRole("note");
});


it("opens the verified project file root rather than listing Home for a project chat", async () => {
 const request=vi.fn(async(url:string)=>url.includes("files-location")?Response.json({path:"projects/matrix-os/repo"}):Response.json({entries:[{name:"MobileNav.tsx",type:"file"}]}));
 vi.stubGlobal("fetch",request);
 render(<WebChatInspector chatId="chat_project" gatewayUrl="http://localhost:4000" layoutKey={null} rootWidth={1512} railWidth={240} project={{id:"project_matrix",slug:"matrix-os"}} filePath={null} onFilePathChange={vi.fn()} terminalSessionIds={[]} sideChatClient={{getSideChat:vi.fn(),createSideChat:vi.fn(),askSideChat:vi.fn()}} onSendToMain={vi.fn()} onClose={vi.fn()}/>);
 await screen.findByRole("treeitem",{name:"MobileNav.tsx"});
 expect(request).toHaveBeenCalledWith("http://localhost:4000/api/projects/matrix-os/files-location?projectId=project_matrix",expect.anything());
 expect(request).toHaveBeenCalledWith("http://localhost:4000/api/files/list?path=projects%2Fmatrix-os%2Frepo",expect.anything());
 expect(request.mock.calls.some(([url])=>url.endsWith("files/list?path="))).toBe(false);
});

function inspectorProps(overrides: Partial<WebChatInspectorProps> = {}): WebChatInspectorProps {
 return {chatId:"chat_regression",gatewayUrl:"http://localhost:4000",layoutKey:null,rootWidth:1512,railWidth:240,filePath:null,onFilePathChange:vi.fn(),terminalSessionIds:[],sideChatClient:{getSideChat:vi.fn(async()=>({threadId:null,messages:[]})),createSideChat:vi.fn(),askSideChat:vi.fn()},onSendToMain:vi.fn(),onClose:vi.fn(),...overrides};
}
it('reopens the current file and saved Side chat from the New tab Recent list', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => Response.json({entries:[]})));
 render(<WebChatInspector {...inspectorProps({filePath:'desktop/src/nav/MobileNav.tsx'})}/>);
 fireEvent.keyDown(screen.getByRole('button',{name:'Add inspector tab'}),{key:'Enter'});
 fireEvent.click(await screen.findByRole('menuitem',{name:'New tab'}));
 fireEvent.click(screen.getByRole('button',{name:'MobileNav.tsxdesktop/src/nav/MobileNav.tsx'}));
 expect(screen.getByRole('tab',{name:'Files'}).getAttribute('aria-selected')).toBe('true');
 expect(screen.queryByRole('tab',{name:'New tab'})).toBeNull();
 fireEvent.keyDown(screen.getByRole('button',{name:'Add inspector tab'}),{key:'Enter'});
 fireEvent.click(await screen.findByRole('menuitem',{name:/^Side chat/}));
 await screen.findByRole('note');
 fireEvent.keyDown(screen.getByRole('button',{name:'Add inspector tab'}),{key:'Enter'});
 fireEvent.click(await screen.findByRole('menuitem',{name:'New tab'}));
 fireEvent.click(screen.getByRole('button',{name:'Side chatSaved conversation'}));
 expect(screen.getByRole('tab',{name:'Side chat'}).getAttribute('aria-selected')).toBe('true');
 expect(screen.queryByRole('tab',{name:'New tab'})).toBeNull();
});
function terminalApi(){
 const workspaceId=`tws_${"a".repeat(32)}`;let created=0;
 const tabs: {id:string;name:string;cwd:string;status:string}[]=[];
 const request=vi.fn(async(url:string,init?:RequestInit)=>{
  if(url.endsWith('/ensure'))return Response.json({workspace:{id:workspaceId}});
  if(init?.method==='POST'){const tab={id:`tt_${(++created).toString(16).padStart(32,'0')}`,name:`Terminal ${created}`,cwd:'~/project',status:'running'};tabs.push(tab);return Response.json({tab});}
  if(url.endsWith('/api/terminal/workspaces'))return Response.json({workspaces:[{id:workspaceId,tabs}]});
  return Response.json({entries:[]});
 });return{request,tabs,workspaceId};
}
it.each([{active:false,visible:true},{active:true,visible:false}])('does not create terminals from shortcuts while Chat is inactive (%o)',async state=>{
 const api=terminalApi();vi.stubGlobal('fetch',api.request);
 render(<ChatApp {...state} messages={[]} sessionId="chat_regression" busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} sideChatClient={inspectorProps().sideChatClient}/>);
 fireEvent.click(screen.getByRole('button',{name:'Toggle chat inspector'}));
 fireEvent.keyDown(window,{key:'`',ctrlKey:true});
 await act(async()=>{await Promise.resolve();});
 expect(api.request.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
});
it('keeps a newly created terminal when an older discovery response arrives late',async()=>{
 const api=terminalApi();let finish!: (value:Response)=>void;let lists=0;
 const request=vi.fn((url:string,init?:RequestInit)=>url.endsWith('/api/terminal/workspaces')&&++lists===1?new Promise<Response>(resolve=>{finish=resolve;}):api.request(url,init));
 vi.stubGlobal('fetch',request);
 const hook=renderHook(()=>useWebChatInspector(inspectorProps({terminalSessionIds:[`${api.workspaceId}:tt_${"b".repeat(32)}`]})));
 await act(async()=>{await hook.result.current.createTerminal();});
 const created=hook.result.current.sessions[0]!;
 await act(async()=>{finish(Response.json({workspaces:[]}));});
 expect(hook.result.current.sessions.some(session=>session.ref===created.ref)).toBe(true);
 act(()=>hook.result.current.closeTab(`terminal:${created.ref}`));
 expect(hook.result.current.closeTarget?.id).toBe(`terminal:${created.ref}`);
});
it('creates more terminals than the bounded mounted-tab window without stopping older sessions',async()=>{
 const api=terminalApi();vi.stubGlobal('fetch',api.request);
 const hook=renderHook(()=>useWebChatInspector(inspectorProps()));
 for(let i=0;i<14;i++)await act(async()=>{await hook.result.current.createTerminal();});
 expect(api.tabs).toHaveLength(14);
 expect(hook.result.current.layout.tabs.length).toBeLessThanOrEqual(12);
 expect(hook.result.current.sessions.length).toBeLessThanOrEqual(12);
 expect(api.request.mock.calls.some(([,init])=>init?.method==='DELETE')).toBe(false);
});
it('keeps the file preview visible when a saved split exceeds the resized panel height',()=>{
 let resize!: ResizeObserverCallback;
 let height=400;
 vi.stubGlobal('ResizeObserver',class{constructor(callback:ResizeObserverCallback){resize=callback;}observe(){}disconnect(){}});
 const original=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'clientHeight');
 Object.defineProperty(HTMLElement.prototype,'clientHeight',{configurable:true,get:()=>height});
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({entries:[]})));
 localStorage.setItem('split-layout',JSON.stringify({width:400,treeHeight:1000,selected:'files',tabs:[{id:'files',kind:'files',label:'Files'}]}));
 try{
  render(<WebChatInspector {...inspectorProps({layoutKey:'split-layout',filePath:'note.txt'})}/>);
  expect(Number(screen.getByRole('separator',{name:'Resize file list'}).getAttribute('aria-valuenow'))).toBeLessThanOrEqual(184);
  height=300;
  act(()=>resize?.([],{} as ResizeObserver));
  expect(Number(screen.getByRole('separator',{name:'Resize file list'}).getAttribute('aria-valuenow'))).toBeLessThanOrEqual(84);
 }finally{if(original)Object.defineProperty(HTMLElement.prototype,'clientHeight',original);else delete (HTMLElement.prototype as Partial<HTMLElement>).clientHeight;}
});
it.each(['failed','missing'])('shows a retryable project-file error when the project lookup is %s',async outcome=>{
 let attempts=0;
 const request=vi.fn(async(url:string)=>{
  if(url.includes('/workspace/projects')){attempts++;if(attempts===1)return outcome==='failed'?new Response('{}',{status:503}):Response.json({projects:[]});return Response.json({projects:[{id:'project_matrix',slug:'matrix-os',name:'Matrix OS'}]});}
  if(url.includes('/files-location'))return Response.json({path:'projects/matrix-os/repo'});
  return Response.json({entries:[]});
 });vi.stubGlobal('fetch',request);
 render(<ChatApp messages={[]} sessionId="chat_regression" chatProjectId="project_matrix" busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} sideChatClient={inspectorProps().sideChatClient}/>);
 fireEvent.click(screen.getByRole('button',{name:'Toggle chat inspector'}));
 expect(await screen.findByText('Project files are unavailable.')).toBeTruthy();
 expect(screen.queryByText('Loading project files…')).toBeNull();
 expect(request.mock.calls.some(([url])=>url.endsWith('/files/list?path='))).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Retry project files'}));
 await waitFor(()=>expect(request.mock.calls.some(([url])=>url.includes('/files/list?path=projects%2Fmatrix-os%2Frepo'))).toBe(true));
});

it.each([false,true])('opens a canonical project chat file through the actual slug-based Gateway preview boundary (mobile=%s)',async mobile=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
 const homePath=await realpath(await mkdtemp(join(tmpdir(),'eng461-preview-boundary-')));
 try{
  const manager=createProjectManager({homePath});
  const created=await manager.createProject({name:'Preview project',slug:'preview-project',mode:'scratch',ownerScope:{type:'user',id:'owner'},clientRequestId:'req_preview_boundary'});
  if(!created.ok)throw new Error('Project fixture failed');
  const project=created.project;
  await mkdir(join(project.localPath,'src'),{recursive:true});
  await writeFile(join(project.localPath,'src','preview.txt'),'Verified project content');
  const {filePreviewService}=createCodingAgentFilePreviewWiring({homePath,ownerId:'owner',projects:{getProjectBySlug:slug=>manager.getProject(slug)}});
  const app=new Hono().route('/api/file-previews',createFilePreviewRoutes({service:filePreviewService,getPrincipal:()=>({userId:'owner',source:'jwt'})}));
  const request=vi.fn(async(url:string)=>{
   const parsed=new URL(url,window.location.origin);
   if(parsed.pathname.startsWith('/api/file-previews/'))return app.request(parsed.pathname+parsed.search);
   if(parsed.pathname.endsWith('/workspace/projects'))return Response.json({projects:[project]});
   if(parsed.pathname.endsWith('/files-location'))return Response.json({path:'projects/preview-project/repo'});
   if(parsed.pathname.endsWith('/files/list'))return Response.json({entries:parsed.searchParams.get('path')?.endsWith('/src')?[{name:'preview.txt',type:'file'}]:[{name:'src',type:'directory'}]});
   return Response.json({entries:[]});
  });vi.stubGlobal('fetch',request);
  render(<ChatApp mobile={mobile} messages={[{id:'message_file',role:'assistant',content:'Changed `src/preview.txt`.',timestamp:1}]} sessionId="chat_preview" chatProjectId={project.id} busy={false} connected conversations={[]} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} sideChatClient={inspectorProps().sideChatClient}/>);
  if(mobile)fireEvent.click(screen.getByRole('button',{name:'Open Chat sidebar'}));
  await screen.findByRole('button',{name:'Expand Preview project chats'});
  if(mobile)fireEvent.click(screen.getByRole('button',{name:'Close Chat sidebar'}));
  fireEvent.click(screen.getByRole('button',{name:'Open preview.txt'}));
  expect(await screen.findByText('Verified project content')).toBeTruthy();
  if (!mobile) expect((await screen.findByRole('treeitem',{name:'preview.txt'})).getAttribute('aria-selected')).toBe('true');
  if (!mobile) {
  expect(screen.queryByRole('group',{name:'Suggested messages'})).toBeNull();
  fireEvent.keyDown(window,{key:'s',metaKey:true,altKey:true});
  expect(screen.getByRole('tab',{name:'Side chat'}).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:'Open preview.txt'}));
  expect(screen.getByRole('tab',{name:'Files'}).getAttribute('aria-selected')).toBe('true');
  }
  expect(request.mock.calls.filter(([url])=>url.includes('/file-previews/')).every(([url])=>new URL(url,window.location.origin).searchParams.get('projectId')===project.slug)).toBe(true);
 }finally{cleanup();await rm(homePath,{recursive:true,force:true});}
});

it('keeps file filtering behind the project-root action and clears it when closed',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url.includes('/files/search?')?{results:[{name:'alpha.txt',path:'alpha.txt',type:'file'}],truncated:false}:{entries:[{name:'alpha.txt',type:'file'},{name:'beta.txt',type:'file'}]})));
 render(<WebChatInspector {...inspectorProps()}/>);
 await screen.findByRole('treeitem',{name:'alpha.txt'});
 expect(screen.queryByRole('searchbox',{name:'Filter files'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Filter files'}));
 fireEvent.change(screen.getByRole('searchbox',{name:'Filter files'}),{target:{value:'alpha'}});
 expect(await screen.findByRole('button',{name:'Open search result alpha.txt'})).toBeTruthy();
 expect(screen.queryByRole('treeitem',{name:'beta.txt'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Close file filter'}));
 expect(screen.queryByRole('searchbox',{name:'Filter files'})).toBeNull();
 expect(await screen.findByRole('treeitem',{name:'beta.txt'})).toBeTruthy();
});

it.each([undefined,{id:'project_matrix',slug:'matrix-os'}])('ensures the terminal workspace in the verified project scope (%o)',async project=>{
 const api=terminalApi();vi.stubGlobal('fetch',api.request);
 const hook=renderHook(()=>useWebChatInspector(inspectorProps({project})));
 await act(async()=>{await hook.result.current.createTerminal();});
 expect(api.request).toHaveBeenCalledWith('http://localhost:4000/api/terminal/workspaces/ensure',expect.objectContaining({body:JSON.stringify(project?{projectId:project.slug}:{})}));
});

it('retains an unsent side question through inspector tab switches',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({entries:[]})));
 render(<WebChatInspector {...inspectorProps()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Add inspector tab'}));fireEvent.click(screen.getByRole('button',{name:/Side chat/}));
 await screen.findByText(/Ask about this chat/);
 fireEvent.change(screen.getByRole('textbox',{name:'Ask side chat'}),{target:{value:'Unsent question'}});
 fireEvent.click(screen.getByRole('tab',{name:'Files'}));fireEvent.click(screen.getByRole('tab',{name:'Side chat'}));
 expect((screen.getByRole('textbox',{name:'Ask side chat'}) as HTMLTextAreaElement).value).toBe('Unsent question');
});
