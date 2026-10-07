// @vitest-environment jsdom
import React, {useState} from "react";
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
