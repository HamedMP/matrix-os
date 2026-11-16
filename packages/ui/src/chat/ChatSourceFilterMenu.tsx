import * as Popover from "@radix-ui/react-popover";
import { ListFilter } from "lucide-react";
import { ChatImportSourceFilter } from "./ChatImportSource.js";
import type { ChatImportSourceFilterValue } from "./import-source.js";
import { POPOVER_LAYER } from "../layering.js";

/** Keep provenance filtering accessible without an extra permanent sidebar row. */
export function ChatSourceFilterMenu({ value, onChange }: { value: ChatImportSourceFilterValue; onChange(value: ChatImportSourceFilterValue): void }) {
  return <Popover.Root><Popover.Trigger asChild><button type="button" aria-label="Filter chats" title="Filter chats" aria-pressed={value !== "all"} className="chat-source-filter-trigger"><ListFilter size={14} aria-hidden/></button></Popover.Trigger>
    <Popover.Portal><Popover.Content side="bottom" align="end" sideOffset={4} className="desktop-chat-design chat-source-filter-menu" style={{ zIndex: POPOVER_LAYER }}><ChatImportSourceFilter value={value} onChange={onChange}/></Popover.Content></Popover.Portal>
  </Popover.Root>;
}
