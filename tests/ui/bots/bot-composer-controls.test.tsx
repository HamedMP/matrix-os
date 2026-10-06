// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BotComposerControls } from '../../../packages/ui/src/chat-agents/bots/BotComposerControls';
import { createCanonicalProviderCatalogFixture } from '../../contracts/fixtures/canonical-chat';
const catalog=createCanonicalProviderCatalogFixture();
const base=catalog.instances[0]!;
catalog.instances=[{...base,id:'matrix_pi_default',driverKind:'matrix_pi',displayName:'Pi',connectionLabel:'Matrix AI',models:[{...base.models[0]!,id:'sonnet',displayName:'Sonnet'}]}];
const bot={recipeRef:{recipeId:'writer',version:'1'},id:'bot_writer01',revision:3,name:'Writer Rabbit',selection:{instanceId:'matrix_pi_default',model:'sonnet'}};
const makeClient=()=>({list:vi.fn(async()=>({enabled:true,agents:[bot]})),update:vi.fn(async(_id:string,input:unknown)=>({...bot,revision:4,selection:(input as {selection:unknown}).selection}))});
afterEach(cleanup);
it('opens the upward model menu from the keyboard and returns focus on Escape',async()=>{
 const client=makeClient();
 render(<BotComposerControls agentId={bot.id} client={client as never} catalog={catalog}/>);
 const trigger=screen.getByRole('button',{name:'Choose bot agent and model'});
 await waitFor(()=>expect(trigger.textContent).toContain('Writer Rabbit'));
 trigger.focus();
 fireEvent.keyDown(trigger,{key:'ArrowUp'});
 const menu=await screen.findByRole('dialog',{name:'Bot agent and model'});
 expect(menu.getAttribute('data-side')).toBe('top');
 expect(menu.getAttribute('data-align')).toBe('end');
 const selector=within(menu).getByRole('combobox',{name:'Bot model'});
 await waitFor(()=>expect(document.activeElement).toBe(selector));
 fireEvent.keyDown(selector,{key:'Escape'});
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Bot agent and model'})).toBeNull());
 expect(document.activeElement).toBe(trigger);
 expect(client.update).not.toHaveBeenCalled();
});
it('shows authenticated agent and model/source and edits only supported models with saved revision',async()=>{
 const client=makeClient(), changed=vi.fn();
 render(<BotComposerControls agentId={bot.id} client={client as never} catalog={catalog} onChanged={changed}/>);
 const trigger=await screen.findByRole('button',{name:'Choose bot agent and model'});
 await waitFor(()=>expect(trigger.textContent).toContain('Writer Rabbit'));
 expect(trigger.textContent).toContain('Sonnet');expect(trigger.textContent).toContain('Matrix AI');
 fireEvent.click(trigger);
 const menu=screen.getByRole('dialog',{name:'Bot agent and model'});
 const selector=within(menu).getByRole('combobox',{name:'Bot model'});
 expect(within(selector).queryByText(/Hermes|Codex|Claude Code/)).toBeNull();
 fireEvent.change(selector,{target:{value:''}});
 await waitFor(()=>expect(client.update).toHaveBeenCalledWith(bot.id,{selection:{instanceId:'matrix_bot_default',model:'auto'},baseRevision:3}));
 expect(changed).toHaveBeenCalledOnce();
 await waitFor(()=>expect(trigger.textContent).toContain('Automatic'));
 expect(trigger.textContent).not.toContain('Matrix AI');
});
it('does not guess a provider for Automatic and preserves selected model after failed update',async()=>{
 const client=makeClient(); client.list.mockResolvedValue({enabled:true,agents:[{...bot,selection:{instanceId:'matrix_bot_default',model:'auto'}}]});
 client.update.mockRejectedValue(new Error('secret/path'));
 render(<BotComposerControls agentId={bot.id} client={client as never} catalog={catalog}/>);
 const trigger=await screen.findByRole('button',{name:'Choose bot agent and model'});
 await waitFor(()=>expect(trigger.textContent).toContain('Automatic'));
 expect(trigger.textContent).not.toContain('Matrix AI');
 fireEvent.click(trigger); fireEvent.change(screen.getByRole('combobox',{name:'Bot model'}),{target:{value:JSON.stringify(['matrix_pi_default','sonnet'])}});
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','Could not change the bot model. Refresh and try again.');
 expect(trigger.textContent).toContain('Automatic');expect(screen.queryByText('secret/path')).toBeNull();
});
it('discards old owner replies and labels when client changes',async()=>{
 let resolve!: (value:unknown)=>void;
 const client={list:vi.fn(()=>new Promise(r=>{resolve=r;}))}, next=makeClient();
 const view=render(<BotComposerControls agentId={bot.id} client={client as never} catalog={catalog}/>);
 view.rerender(<BotComposerControls agentId="bot_other001" client={next as never} catalog={catalog}/>);
 await act(async()=>resolve({enabled:true,agents:[bot]}));
 expect(screen.queryByText('Writer Rabbit')).toBeNull();
 expect(screen.getByRole('button',{name:'Choose bot agent and model'}).textContent).not.toContain('Sonnet');
});

it('keeps an unsupported saved Bot route distinct from Automatic',async()=>{
 const client=makeClient();client.list.mockResolvedValue({enabled:true,agents:[{...bot,selection:{instanceId:'codex_default',model:'gpt-old'}}]});
 render(<BotComposerControls agentId={bot.id} client={client as never} catalog={catalog}/>);
 const trigger=await screen.findByRole('button',{name:'Choose bot agent and model'});
 await waitFor(()=>expect(trigger.textContent).toContain('Writer Rabbit'));
 expect(trigger.textContent).toContain('gpt-old · unavailable');
 expect(trigger.textContent).not.toContain('Automatic');
 expect(client.update).not.toHaveBeenCalled();
});
