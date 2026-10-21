import type { BotMemoryItem } from "@matrix-os/contracts";
import { chatAgentMutedStyle } from "../theme.js";

export function RememberedItemPart({ item }: { item: BotMemoryItem }) {
  return <div className="grid gap-1">
    <p className="whitespace-pre-wrap text-sm">{item.content}</p>
    <p className="text-xs" style={chatAgentMutedStyle}>
      {item.source.messageId ? "From Chat" : item.source.url ? "From a web source" : "Remembered"} · {item.source.at.slice(0, 10)}
      {item.confirmed ? " · Confirmed" : " · Needs confirmation"}
    </p>
  </div>;
}
