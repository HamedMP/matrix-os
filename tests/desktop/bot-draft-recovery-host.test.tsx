// @vitest-environment jsdom
import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {$getRoot,$getSelection,$isRangeSelection,getNearestEditorFromDOMNode} from 'lexical';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CanonicalChatWorkspace} from '@desktop/renderer/src/features/chat/CanonicalChatWorkspace';
import {useConnection} from '@desktop/renderer/src/stores/connection';
import {createCanonicalChatWorkspaceClient,canonicalChatRecord,providerCatalog} from './canonical-chat-workspace-test-utils';
import {setSharedComposerText} from './shared-chat-composer-test-utils';
import {clientFixture,saved} from './chat-agents-fixture';
afterEach(cleanup);
beforeEach(()=>{vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});useConnection.setState(useConnection.getInitialState(),true);});
it.each([[undefined,null],['chat_original',null],[undefined,'project_alpha']] as const)('returns a conflicting Bot handoff to Electron source %s in Project %s without resetting its draft',async(sourceId,projectId)=>{
 const client=createCanonicalChatWorkspaceClient();const agents=clientFixture();const bot={...saved,recipeRef:{recipeId:'writer',version:'1'},selection:{instanceId:'matrix_bot_default',model:'automatic'}};
 agents.list.mockResolvedValue({enabled:true,agents:[bot]});agents.search.mockResolvedValue({enabled:true,resources:[{kind:'agent',id:bot.id,label:bot.name},{kind:'chat',id:'chat_notes',label:'Original notes'}]});
 agents.bots={directChat:vi.fn(async()=> 'chat_bot'),directBot:vi.fn(async(id:string)=>id==='chat_bot'?bot.id:null),interactions:vi.fn(async()=>[]),tasks:vi.fn(async()=>[]),authority:vi.fn(async()=>({grants:[],connections:[],memory:{items:[]},routines:[],pendingInteractions:[]}))} as never;client.agents=agents;
 let targetReload:Promise<void>|null=null;
 let releaseTargetReload:()=>void=()=>{};
 vi.mocked(client.getDetail).mockImplementation(async id=>{
  if(id==='chat_bot' && targetReload) await targetReload;
  return {record:{...canonicalChatRecord,chat:{...canonicalChatRecord.chat,id}},messages:[],turns:[],runs:[],activities:[]};
 });
 function Workspace(){const[id,setId]=React.useState<string|undefined>('chat_bot');return <><button onClick={()=>setId(sourceId)}>Begin original source</button><CanonicalChatWorkspace client={client} projectId={projectId} initialChatId={id} initialView={id?'conversation':'draft'} active catalog={providerCatalog} onActiveChatChanged={next=>setId(next??undefined)}/></>;}
 render(<Workspace/>);let editor=await screen.findByRole('textbox',{name:'Reply to chat'});await setSharedComposerText(editor,'Protected target draft');
 fireEvent.click(screen.getByRole('button',{name:'Begin original source'}));editor=await screen.findByRole('textbox',{name:sourceId?'Reply to chat':'Start a chat'});
 await setSharedComposerText(editor,'@notes');fireEvent.click(await screen.findByRole('option',{name:/Original notes/}));
 await screen.findByTestId('composer-reference-token-chat-chat_notes');
 await act(async()=>{getNearestEditorFromDOMNode(editor).update(()=>{$getRoot().selectStart();const selection=$getSelection();if($isRangeSelection(selection))selection.insertText('Recover this original draft @Mee');},{discrete:true});});
 // Choose the Bot from the text preceding the retained inline reference.
 targetReload=new Promise<void>(resolve=>{releaseTargetReload=resolve;});
 fireEvent.click(await screen.findByRole('option',{name:/Meeting helper/}));
 // Recovery is available before the asynchronous target detail mounts its editor.
 await screen.findByRole('button',{name:'Return to original draft'});
 await act(async()=>{releaseTargetReload();await targetReload;});
 await screen.findByRole('textbox',{name:'Reply to chat'});
 await waitFor(()=>expect(screen.getByRole('textbox',{name:'Reply to chat'}).textContent).toContain('Protected target draft'));
 fireEvent.click(screen.getByRole('button',{name:'Return to original draft'}));editor=await screen.findByRole('textbox',{name:sourceId?'Reply to chat':'Start a chat'});
 await waitFor(()=>expect(editor.textContent).toContain('Recover this original draft @Mee'));expect(client.admitTurn).not.toHaveBeenCalled();expect(client.create).not.toHaveBeenCalled();expect(screen.getByTestId('composer-reference-token-chat-chat_notes')).toBeTruthy();
 if(projectId) {expect(document.querySelector('[data-slot=chat-project-draft-scroll]')).toBeTruthy();expect(screen.queryByText('What should we build today?')).toBeNull();}
 fireEvent.click(screen.getByRole('button',{name:'New chat'}));editor=await screen.findByRole('textbox',{name:'Start a chat'});await waitFor(()=>expect(editor.textContent).toBe(''));expect(screen.queryByRole('button',{name:'Return to original draft'})).toBeNull();
});
it('keeps Electron source local files and draft in place instead of navigating to a Bot',async()=>{
 const client=createCanonicalChatWorkspaceClient(),agents=clientFixture();const bot={...saved,recipeRef:{recipeId:'writer',version:'1'}};
 agents.list.mockResolvedValue({enabled:true,agents:[bot]});agents.search.mockResolvedValue({enabled:true,resources:[{kind:'agent',id:bot.id,label:bot.name}]});agents.bots={directChat:vi.fn(async()=> 'chat_bot')} as never;client.agents=agents;
 render(<CanonicalChatWorkspace client={client} projectId={null} initialView='draft' active catalog={providerCatalog}/>);
 const editor=await screen.findByRole('textbox',{name:'Start a chat'});
 fireEvent.change(screen.getByLabelText('Choose files'),{target:{files:[new File(['Source'],'original.txt',{type:'text/plain'})]}});
 await setSharedComposerText(editor,'Keep this file and text @Mee');fireEvent.click(await screen.findByRole('option',{name:/Meeting helper/}));
 await screen.findByText(/Remove or send the attached files/);expect(screen.getByRole('textbox',{name:'Start a chat'}).textContent).toContain('Keep this file and text');
 expect(screen.getByRole('button',{name:'Remove original.txt'})).toBeTruthy();expect(client.getDetail).not.toHaveBeenCalled();expect(client.admitTurn).not.toHaveBeenCalled();expect(screen.queryByRole('button',{name:'Return to original draft'})).toBeNull();
});
