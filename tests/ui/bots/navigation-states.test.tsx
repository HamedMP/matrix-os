// @vitest-environment jsdom
import React, {Suspense, startTransition, useEffect, useState} from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatAgentsRailSection } from "../../../packages/ui/src/chat-agents/ChatAgentsRailSection.js";
import { BotChatPanel } from "../../../packages/ui/src/chat-agents/bots/BotChatPanel.js";
import { ChatAgentsWorkspace, useChatAgentsNavigation } from "../../../packages/ui/src/chat-agents/ChatAgentsNavigation.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture";

afterEach(cleanup);
it("resets uncontrolled Agent disclosure when the authenticated client changes", async () => {
  const first = clientFixture(), replacement = clientFixture();
  first.list.mockResolvedValue({enabled: true, agents: [saved]});
  replacement.list.mockResolvedValue({enabled: true, agents: [saved]});
  const rail = (client: typeof first) => <ChatAgentsWorkspace><ChatAgentsRailSection client={client}/></ChatAgentsWorkspace>;
  const view = render(rail(first));
  fireEvent.click(await screen.findByRole("button", {name: "Collapse agents"}));
  expect(screen.getByRole("button", {name: "Expand agents"})).toBeTruthy();
  view.rerender(rail(replacement));
  expect(await screen.findByRole("button", {name: "Collapse agents"})).toBeTruthy();
});
it("shows the real Agent count only when collapsed and keeps management separate", async () => {
  const client = clientFixture();
  client.list.mockResolvedValue({enabled: true, agents: [saved]});
  render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client}/></ChatAgentsWorkspace>);
  const collapse = await screen.findByRole("button", {name: "Collapse agents"});
  expect(screen.queryByLabelText("1 agent")).toBeNull();
  fireEvent.click(collapse);
  expect(screen.getByLabelText("1 agent").textContent).toBe("1");
  expect(screen.getByRole("button", {name: "Agents"}).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(screen.getByRole("button", {name: "Agents"}));
  expect(screen.getByRole("button", {name: "Agents"}).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", {name: "Expand agents"}).getAttribute("aria-expanded")).toBe("false");
});

it("marks only the authenticated current Agent and shows full long titles", async () => {
  const base = clientFixture();
  const other = {...saved, id: "bot_other001", name: "Another Agent with a long descriptive name"};
  base.list.mockResolvedValue({enabled: true, agents: [saved, other]});
  const renderRail = (activeAgentId: string | null) => <ChatAgentsWorkspace><ChatAgentsRailSection client={base} activeChatId="chat_bot" activeAgentId={activeAgentId}/></ChatAgentsWorkspace>;
  const view = render(renderRail(saved.id));
  const current = await screen.findByRole("button", {name: `Chat with ${saved.name}`});
  expect(current.getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", {name: `Chat with ${other.name}`}).getAttribute("aria-current")).toBeNull();
  expect(screen.getByText(other.name).getAttribute("title")).toBe(other.name);
  view.rerender(renderRail(null));
  expect(current.getAttribute("aria-current")).toBeNull();
});

it.each([false, true])("opens existing Bot Details without sending when the host closes Agents: %s", async closesAgents => {
  const base = clientFixture();
  base.list.mockResolvedValue({enabled: true, agents: [saved]});
  const ensureDirectChat = vi.fn(async () => "chat_bot");
  const client = {...base, bots: {ensureDirectChat}} as unknown as import("../../../packages/ui/src/chat-agents/client.js").ChatAgentClient;
  const start = vi.fn();
  function Host() {
    const navigation = useChatAgentsNavigation();
    const [chatId, setChatId] = useState<string>();
    return <><ChatAgentsRailSection client={client} activeChatId={chatId} onOpenBotChat={chat => { if (closesAgents) navigation?.close(); setChatId(chat); }} onStartChat={start}/>
      <BotChatPanel key={chatId} client={client} chatId={chatId} directBotId={chatId ? saved.id : null}/></>;
  }
  render(<ChatAgentsWorkspace><Host/></ChatAgentsWorkspace>);
  const menu = await screen.findByRole("button", {name: `Actions for ${saved.name}`});
  fireEvent.keyDown(menu, {key: "Enter"});
  fireEvent.click(await screen.findByRole("menuitem", {name: "Details"}));
  expect(await screen.findByRole("complementary", {name: "Bot details"})).toBeTruthy();
  expect(ensureDirectChat).toHaveBeenCalledWith(saved.id);
  expect(start).not.toHaveBeenCalled();
  expect(screen.queryByText("Pause")).toBeNull();
  expect(screen.queryByText("Archive")).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: "Close bot details"}));
  await waitFor(() => expect(screen.queryByRole("complementary", {name: "Bot details"})).toBeNull());
});

it('discards a late Details binding after the user changes Chats', async()=>{
  let finish!: (id: string)=>void;
  const base=clientFixture();base.list.mockResolvedValue({enabled:true,agents:[saved]});
  const ensureDirectChat=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}));
  const client={...base,bots:{ensureDirectChat}} as unknown as import('../../../packages/ui/src/chat-agents/client.js').ChatAgentClient;
  const open=vi.fn();
  const view=render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client} activeChatId="chat_old" onOpenBotChat={open}/></ChatAgentsWorkspace>);
  fireEvent.keyDown(await screen.findByRole('button',{name:`Actions for ${saved.name}`}),{key:'Enter'});
  fireEvent.click(await screen.findByRole('menuitem',{name:'Details'}));
  view.rerender(<ChatAgentsWorkspace><ChatAgentsRailSection client={client} activeChatId="chat_new" onOpenBotChat={open}/></ChatAgentsWorkspace>);
  await React.act(async()=>{finish('chat_bot');});
  expect(open).not.toHaveBeenCalled();
});

it.each(['client','navigation'])('ignores a late Details lookup after %s changes',async mode=>{
  let finish!: (id:string)=>void;
  const base=clientFixture();base.list.mockResolvedValue({enabled:true,agents:[saved]});
  const oldClient={...base,bots:{ensureDirectChat:vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}))}} as unknown as import('../../../packages/ui/src/chat-agents/client.js').ChatAgentClient;
  const replacement=clientFixture();replacement.list.mockResolvedValue({enabled:true,agents:[saved]});
  const open=vi.fn();
  const rail=(client: import('../../../packages/ui/src/chat-agents/client.js').ChatAgentClient)=><ChatAgentsWorkspace><ChatAgentsRailSection client={client} activeChatId="chat_old" onOpenBotChat={open}/></ChatAgentsWorkspace>;
  const view=render(rail(oldClient));
  fireEvent.keyDown(await screen.findByRole('button',{name:`Actions for ${saved.name}`}),{key:'Enter'});
  fireEvent.click(await screen.findByRole('menuitem',{name:'Details'}));
  if(mode==='client')view.rerender(rail(replacement));
  else fireEvent.click(screen.getByRole('button',{name:'Agents'}));
  await React.act(async()=>{finish('chat_bot');});
  expect(open).not.toHaveBeenCalled();
});

it('does not open Details in another Chat after the host transition settles late',async()=>{
  let finish!: ()=>void;
  const base=clientFixture();base.list.mockResolvedValue({enabled:true,agents:[saved]});
  const client={...base,bots:{ensureDirectChat:vi.fn(async()=> 'chat_bot')}} as unknown as import('../../../packages/ui/src/chat-agents/client.js').ChatAgentClient;
  const open=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const rail=(activeChatId:string)=><ChatAgentsWorkspace><ChatAgentsRailSection client={client} activeChatId={activeChatId} onOpenBotChat={open}/><BotChatPanel key={activeChatId} client={client} chatId={activeChatId} directBotId={saved.id}/></ChatAgentsWorkspace>;
  const view=render(rail('chat_old'));
  fireEvent.keyDown(await screen.findByRole('button',{name:`Actions for ${saved.name}`}),{key:'Enter'});
  fireEvent.click(await screen.findByRole('menuitem',{name:'Details'}));
  await waitFor(()=>expect(open).toHaveBeenCalledWith('chat_bot'));
  view.rerender(rail('chat_other'));
  await React.act(async()=>{finish();});
  expect(screen.queryByRole('complementary',{name:'Bot details'})).toBeNull();
});

it.each(['client', 'navigation'])('does not close newer management after a late host transition changes %s', async mode => {
  let finish!: () => void;
  const base = clientFixture();
  base.list.mockResolvedValue({enabled: true, agents: [saved]});
  const client = {...base, bots: {ensureDirectChat: vi.fn(async () => 'chat_bot')}} as unknown as import('../../../packages/ui/src/chat-agents/client.js').ChatAgentClient;
  const replacement = clientFixture();
  replacement.list.mockResolvedValue({enabled: true, agents: [saved]});
  const open = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const accepted = vi.fn();
  const rail = (current: import('../../../packages/ui/src/chat-agents/client.js').ChatAgentClient) =>
    <ChatAgentsWorkspace><ChatAgentsRailSection client={current} activeChatId="chat_old" onOpen={accepted} onOpenBotChat={open}/></ChatAgentsWorkspace>;
  const view = render(rail(client));
  fireEvent.keyDown(await screen.findByRole('button', {name: `Actions for ${saved.name}`}), {key: 'Enter'});
  fireEvent.click(await screen.findByRole('menuitem', {name: 'Details'}));
  await waitFor(() => expect(open).toHaveBeenCalledWith('chat_bot'));
  if (mode === 'client') view.rerender(rail(replacement));
  fireEvent.click(await screen.findByRole('button', {name: 'Agents', exact: true}));
  expect(screen.getByRole('button', {name: 'Agents', exact: true}).getAttribute('aria-pressed')).toBe('true');
  accepted.mockClear();
  await React.act(async () => { finish(); });
  expect(screen.getByRole('button', {name: 'Agents', exact: true}).getAttribute('aria-pressed')).toBe('true');
  expect(accepted).not.toHaveBeenCalled();
});


it.each(['Chat', 'client'])('keeps committed Details scope when a changed %s render suspends before commit', async mode => {
  const base = clientFixture();
  base.list.mockResolvedValue({enabled: true, agents: [saved]});
  const replacement = clientFixture();
  replacement.list.mockResolvedValue({enabled: true, agents: [saved]});
  let finishBinding!: (chatId: string) => void;
  let finishHost!: () => void;
  const ensureDirectChat = vi.fn(() => new Promise<string>(resolve => { finishBinding = resolve; }));
  const client = {...base, bots: {ensureDirectChat}} as unknown as import('../../../packages/ui/src/chat-agents/client.js').ChatAgentClient;
  const onOpenBotChat = vi.fn(() => new Promise<void>(resolve => { finishHost = resolve; }));
  const accepted = vi.fn();
  const attemptedSuspension = vi.fn();
  const pending = new Promise<never>(() => {});
  let suspendChangedScope!: () => void;
  function Gate({blocked}: {blocked: boolean}) {
    if (blocked) { attemptedSuspension(); throw pending; }
    return null;
  }
  function DetailsTarget() {
    const navigation = useChatAgentsNavigation();
    return <output aria-label="Details target" data-original-client={navigation?.detailsRequest?.client === client}>
      {navigation?.detailsRequest?.chatId ?? 'none'}
    </output>;
  }
  function Host() {
    const [blocked, setBlocked] = useState(false);
    useEffect(() => { suspendChangedScope = () => startTransition(() => setBlocked(true)); }, []);
    return <Suspense fallback={<p>Replacement loading</p>}>
      <ChatAgentsRailSection client={blocked && mode === 'client' ? replacement : client}
        activeChatId={blocked && mode === 'Chat' ? 'chat_abandoned' : 'chat_committed'}
        onOpen={accepted} onOpenBotChat={onOpenBotChat}/>
      <Gate blocked={blocked}/><DetailsTarget/>
    </Suspense>;
  }
  render(<ChatAgentsWorkspace><Host/></ChatAgentsWorkspace>);
  fireEvent.keyDown(await screen.findByRole('button', {name: `Actions for ${saved.name}`}), {key: 'Enter'});
  fireEvent.click(await screen.findByRole('menuitem', {name: 'Details'}));
  await waitFor(() => expect(ensureDirectChat).toHaveBeenCalledWith(saved.id));
  if (mode === 'client') {
    await React.act(async () => { finishBinding('chat_bot'); });
    await waitFor(() => expect(onOpenBotChat).toHaveBeenCalledWith('chat_bot'));
  }
  await React.act(async () => { suspendChangedScope(); });
  expect(attemptedSuspension).toHaveBeenCalled();
  expect(screen.queryByText('Replacement loading')).toBeNull();
  expect(screen.getByRole('button', {name: `Chat with ${saved.name}`})).toBeTruthy();
  if (mode === 'Chat') await React.act(async () => { finishBinding('chat_bot'); });
  await waitFor(() => expect(onOpenBotChat).toHaveBeenCalledWith('chat_bot'));
  await React.act(async () => { finishHost(); });
  await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
  expect(screen.getByLabelText('Details target').textContent).toBe('chat_bot');
  expect(screen.getByLabelText('Details target').getAttribute('data-original-client')).toBe('true');
});


it.each(['accepted', 'client', 'Chat', 'navigation', 'unmount'])('settles a delayed host that synchronously closed Agents with %s scope', async mode => {
  const base = clientFixture();
  base.list.mockResolvedValue({enabled: true, agents: [saved]});
  const client = {...base, bots: {ensureDirectChat: vi.fn(async () => 'chat_bot')}} as unknown as import('../../../packages/ui/src/chat-agents/client.js').ChatAgentClient;
  let finishHost!: () => void;
  const transition = new Promise<void>(resolve => { finishHost = resolve; });
  const opened = vi.fn();
  const committedHost = vi.fn();
  const start = vi.fn();
  function Host({current = client, chatOverride}: {current?: typeof client; chatOverride?: string}) {
    const navigation = useChatAgentsNavigation();
    const [chatId, setChatId] = useState<string>();
    useEffect(() => { if (chatId) committedHost(chatId); }, [chatId]);
    return <><ChatAgentsRailSection client={current} activeChatId={chatOverride ?? chatId} onOpen={opened} onStartChat={start}
      onOpenBotChat={chatId => { navigation?.close(); setChatId(chatId); return transition; }}/>
      <BotChatPanel key={chatOverride ?? chatId} client={current} chatId={chatOverride ?? chatId} directBotId={chatId ? saved.id : null}/></>;
  }
  const rail = (current = client, chatOverride?: string) => <ChatAgentsWorkspace><Host current={current} chatOverride={chatOverride}/></ChatAgentsWorkspace>;
  const view = render(rail());
  fireEvent.keyDown(await screen.findByRole('button', {name: `Actions for ${saved.name}`}), {key: 'Enter'});
  const details = await screen.findByRole('menuitem', {name: 'Details'});
  await React.act(async () => { fireEvent.click(details); });
  // Wait for the host's navigation/Chat change to commit while its promise is pending.
  await waitFor(() => expect(committedHost).toHaveBeenCalledWith('chat_bot'));
  expect(screen.queryByRole('complementary', {name: 'Bot details'})).toBeNull();
  if (mode === 'client') {
    const replacement = clientFixture();
    replacement.list.mockResolvedValue({enabled: true, agents: [saved]});
    view.rerender(rail(replacement));
  } else if (mode === 'Chat') view.rerender(rail(client, 'chat_other'));
  else if (mode === 'navigation') {
    fireEvent.click(screen.getByRole('button', {name: 'Agents', exact: true}));
    opened.mockClear();
  } else if (mode === 'unmount') view.unmount();
  await React.act(async () => { finishHost(); });
  if (mode === 'accepted') {
    expect(await screen.findByRole('complementary', {name: 'Bot details'})).toBeTruthy();
    expect(opened).toHaveBeenCalledOnce();
  } else {
    expect(screen.queryByRole('complementary', {name: 'Bot details'})).toBeNull();
    expect(opened).not.toHaveBeenCalled();
    if (mode === 'navigation') expect(screen.getByRole('button', {name: 'Agents', exact: true}).getAttribute('aria-pressed')).toBe('true');
  }
  expect(start).not.toHaveBeenCalled();
});


it('rejects an older delayed host completion when a newer Details lookup starts after its accepted close', async () => {
  const base = clientFixture();
  base.list.mockResolvedValue({enabled: true, agents: [saved]});
  let finishSecondBinding!: (chatId: string) => void;
  let finishFirstHost!: () => void;
  const secondBinding = new Promise<string>(resolve => { finishSecondBinding = resolve; });
  const firstHost = new Promise<void>(resolve => { finishFirstHost = resolve; });
  const ensureDirectChat = vi.fn().mockResolvedValueOnce('chat_bot').mockImplementationOnce(() => secondBinding);
  const client = {...base, bots: {ensureDirectChat}} as unknown as import('../../../packages/ui/src/chat-agents/client.js').ChatAgentClient;
  const committedHost = vi.fn();
  const accepted = vi.fn();
  const onOpenBotChat = vi.fn();
  function Host() {
    const navigation = useChatAgentsNavigation();
    const [chatId, setChatId] = useState<string>();
    useEffect(() => { if (chatId) committedHost(chatId); }, [chatId]);
    return <><ChatAgentsRailSection client={client} activeChatId={chatId} onOpen={accepted}
      onOpenBotChat={chatId => {
        onOpenBotChat(chatId); navigation?.close(); setChatId(chatId);
        return onOpenBotChat.mock.calls.length === 1 ? firstHost : Promise.resolve();
      }}/><BotChatPanel key={chatId} client={client} chatId={chatId} directBotId={chatId ? saved.id : null}/></>;
  }
  render(<ChatAgentsWorkspace><Host/></ChatAgentsWorkspace>);
  const openDetails = async () => {
    fireEvent.keyDown(await screen.findByRole('button', {name: `Actions for ${saved.name}`}), {key: 'Enter'});
    const details = await screen.findByRole('menuitem', {name: 'Details'});
    await React.act(async () => { fireEvent.click(details); });
  };
  await openDetails();
  await waitFor(() => expect(committedHost).toHaveBeenCalledWith('chat_bot'));
  await openDetails();
  await waitFor(() => expect(ensureDirectChat).toHaveBeenCalledTimes(2));
  await React.act(async () => { finishFirstHost(); });
  expect(accepted).not.toHaveBeenCalled();
  expect(screen.queryByRole('complementary', {name: 'Bot details'})).toBeNull();
  await React.act(async () => { finishSecondBinding('chat_bot'); });
  expect(await screen.findByRole('complementary', {name: 'Bot details'})).toBeTruthy();
  expect(accepted).toHaveBeenCalledOnce();
  expect(onOpenBotChat).toHaveBeenCalledTimes(2);
});
