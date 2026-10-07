import { Ellipsis } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useState } from "react";
import type { ChatAgent } from "@matrix-os/contracts";
import { AgentAvatar } from "./AgentAvatar.js";
import type { BotRailStatus } from "./bots/bot-rail-status.js";

export function ChatAgentRailRow({agent, status, current, opening, disabled, onOpen, menuZIndex}: {
  menuZIndex: number; agent: ChatAgent; status?: BotRailStatus; current: boolean; opening: boolean; disabled: boolean;
  onOpen(details: boolean): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className="matrix-chat-agent-rail-item" data-current={current} data-menu-open={menuOpen} data-agent-rail-state={status?.state}>
    <button type="button" aria-current={current ? "page" : undefined} aria-label={`Chat with ${agent.name}`} aria-busy={opening} disabled={disabled}
      className="matrix-chat-agent-rail-row" onClick={() => onOpen(false)}>
      <AgentAvatar id={agent.id} name={agent.name} size="small" />
      <span className="matrix-chat-agent-rail-copy"><span data-slot="chat-agent-name" className="matrix-chat-agent-rail-name" title={agent.name}>{agent.name}</span>
        <span data-slot="chat-agent-status" className="matrix-chat-agent-rail-status" title={status?.label}>{status?.label}</span></span>
      <span aria-hidden="true" data-slot="chat-agent-indicator" className="matrix-chat-agent-rail-indicator" data-state={status?.state}/>
    </button>
    <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenu.Trigger asChild><button type="button" aria-label={`Actions for ${agent.name}`} disabled={disabled} className="matrix-chat-agent-rail-more">
        <Ellipsis aria-hidden="true" size={15} strokeWidth={1.5}/>
      </button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="matrix-chat-agent-rail-menu" sideOffset={4} align="end" style={{zIndex: menuZIndex}}>
        <DropdownMenu.Item className="matrix-chat-agent-rail-menu-item" onSelect={() => onOpen(true)}>Details</DropdownMenu.Item>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>;
}
