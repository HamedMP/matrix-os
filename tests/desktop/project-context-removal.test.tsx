// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CanonicalChatWorkspace } from '@desktop/renderer/src/features/chat/CanonicalChatWorkspace';
import { openWorkProject, openWorkProjectDraft } from "@desktop/renderer/src/features/work/work-navigation";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useBoard } from '@desktop/renderer/src/stores/board';
import { useConnection } from '@desktop/renderer/src/stores/connection';
import { createCanonicalChatWorkspaceClient, canonicalChatRecord, providerCatalog, snapshot } from './canonical-chat-workspace-test-utils';
import { setSharedComposerText } from './shared-chat-composer-test-utils';
vi.mock('@desktop/renderer/src/features/chat/ChatProviderOnboarding', () => ({ ChatProviderOnboarding: ({children}: {children: React.ReactNode}) => <>{children}</> }));
globalThis.ResizeObserver = class implements ResizeObserver { observe() {} unobserve() {} disconnect() {} };
beforeEach(() => {
 useTabs.setState(useTabs.getInitialState(), true);
 useBoard.setState(useBoard.getInitialState(), true); useConnection.setState(useConnection.getInitialState(), true);
 useBoard.setState({projects: [{id:'matrix-os',slug:'matrix-os',name:'Matrix OS',kind:'folder'} as never]});
 useConnection.setState({api: {get: vi.fn(async()=>({})),patch:vi.fn()} as never});
});
afterEach(cleanup);
it('removes Project from an unsent draft without clearing text or reapplying it during submit', async () => {
 const client=createCanonicalChatWorkspaceClient();
 vi.mocked(client.create).mockRejectedValue(new Error('fixture failure'));
 render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialView="draft" externalNavigation active catalog={providerCatalog}/>);
 await screen.findByRole('textbox',{name:'Start a chat'});
 await setSharedComposerText(screen.getByRole('textbox',{name:'Start a chat'}),'draft remains');
 fireEvent.click(screen.getByRole('button',{name:'Project Matrix OS'}));
 fireEvent.click(await screen.findByRole('button',{name:'Remove project context'}));
 expect(screen.queryByRole('button',{name:'Project Matrix OS'})).toBeNull();
 expect(screen.getByRole('textbox',{name:'Start a chat'}).textContent).toBe('draft remains');
 fireEvent.click(screen.getByRole('button',{name:'Send'}));
 await waitFor(()=>expect(client.create).toHaveBeenCalledWith(expect.not.objectContaining({projectId:expect.anything()})));
});
it('reflects an existing Chat detached by the server without borrowing its old route Project',async()=>{
 const client=createCanonicalChatWorkspaceClient();
 vi.mocked(client.getDetail).mockResolvedValue({record:{...canonicalChatRecord,projectId:null},messages:snapshot.messages,turns:snapshot.turns,runs:snapshot.runs,activities:snapshot.activities});
 render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={snapshot.chat.id} initialView="conversation" externalNavigation active catalog={providerCatalog}/>);
 await screen.findByRole('textbox',{name:'Reply to chat'});
 expect(screen.queryByRole('button',{name:'Project Matrix OS'})).toBeNull();
 expect(screen.getByRole('button',{name:'Add to project'})).toBeTruthy();
});

it.each([true,false])('detaches existing Chat only after successful revision-checked move (success=%s)',async success=>{
 const client=createCanonicalChatWorkspaceClient();
 if(success) vi.mocked(client.updateProject).mockResolvedValue({...canonicalChatRecord,projectId:null,chat:{...canonicalChatRecord.chat,revision:canonicalChatRecord.chat.revision+1}});
 else vi.mocked(client.updateProject).mockRejectedValue(new Error('conflict'));
 render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={snapshot.chat.id} initialView="conversation" externalNavigation active catalog={providerCatalog}/>);
 await screen.findByRole('textbox',{name:'Reply to chat'});
 fireEvent.click(screen.getByRole('button',{name:'Project Matrix OS'}));
 fireEvent.click(await screen.findByRole('button',{name:'Remove project context'}));
 await waitFor(()=>expect(client.updateProject).toHaveBeenCalledWith(snapshot.chat.id,{baseRevision:canonicalChatRecord.chat.revision,projectId:null}));
 if(success) await screen.findByRole('button',{name:'Add to project'});
 else { expect(await screen.findByRole('alert')).toHaveProperty('textContent','The Chat could not be moved. Refresh and try again.');expect(screen.getByRole('button',{name:'Project Matrix OS'})).toBeTruthy(); }
});

it('opens a same-Project ordinary draft, preserves text, and admits no Project after explicit removal', async () => {
 const project = useBoard.getState().projects[0]!;
 openWorkProject(project);
 const client = createCanonicalChatWorkspaceClient();
 vi.mocked(client.create).mockRejectedValue(new Error('fixture failure'));
 function RoutedProject() {
  const tab = useTabs(state => state.tabs[0]);
  return <CanonicalChatWorkspace client={client} projectId={project.id!} projectLabel={project.name}
   initialChatId={tab?.chatId} initialView={tab?.chatView} externalNavigation active catalog={providerCatalog}/>;
 }
 render(<RoutedProject/>);
 const editor = await screen.findByRole('textbox', {name: 'Start a chat'});
 await setSharedComposerText(editor, 'Unsent project draft');
 act(() => { openWorkProjectDraft(project); });
 expect(useTabs.getState().tabs[0]).toMatchObject({chatView:'draft',projectSlug:project.slug,chatId:undefined});
 expect(screen.getByRole('textbox',{name:'Start a chat'}).textContent).toBe('Unsent project draft');
 expect(client.create).not.toHaveBeenCalled();
 expect(client.admitTurn).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Project Matrix OS'}));
 fireEvent.click(await screen.findByRole('button',{name:'Remove project context'}));
 fireEvent.click(screen.getByRole('button',{name:'Send'}));
 await waitFor(() => expect(client.create).toHaveBeenCalledWith(expect.not.objectContaining({projectId:expect.anything()})));
});
