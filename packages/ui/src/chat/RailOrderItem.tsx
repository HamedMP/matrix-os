import { createContext, useContext, type ReactNode } from "react";
export const ChatRailOrderContext = createContext<{manual:boolean; scopeKey?:string; move:(kind:"chat"|"project",source:string,target:string)=>void}>({manual:false,move:()=>undefined});
const DRAG_TYPE = "application/x-matrix-chat-rail";
export function ChatRailOrderItem({id,kind,group,children}: {id:string; kind:"chat"|"project"; group:string; children:ReactNode}) {
  const order = useContext(ChatRailOrderContext);
  return <div data-rail-order-id={id} data-rail-order-kind={kind} data-rail-order-group={group} draggable={order.manual}
    title={order.manual ? "Drag to reorder, or use Alt + Up / Down" : undefined}
    onDragStart={event=> {
      if (!order.manual || (event.target as HTMLElement).closest("[data-rail-order-id]") !== event.currentTarget) return;
      event.stopPropagation();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(DRAG_TYPE,JSON.stringify({id,kind,group,scopeKey:order.scopeKey}));
    }}
    onDragOver={event=> { if (order.manual && event.dataTransfer.types.includes(DRAG_TYPE)) {event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect="move";} }}
    onDrop={event=> {
      if (!order.manual) return;
      event.preventDefault(); event.stopPropagation();
      try {
        const raw = event.dataTransfer.getData(DRAG_TYPE);
        if (raw.length > 2048) return;
        const source: unknown = JSON.parse(raw);
        if (source && typeof source === "object" && "id" in source && typeof source.id === "string" && "kind" in source && source.kind === kind && "group" in source && source.group === group && ("scopeKey" in source ? source.scopeKey : undefined) === order.scopeKey) order.move(kind,source.id,id);
      } catch (error: unknown) { if (!(error instanceof SyntaxError)) console.warn("[work] Rail drop unavailable:", error instanceof Error ? error.name : "UnknownError"); }
    }}
    onKeyDown={event=> {
      if (!order.manual || !event.altKey || !["ArrowUp","ArrowDown"].includes(event.key) || (event.target as HTMLElement).closest("[data-rail-order-id]") !== event.currentTarget) return;
      const siblings = [...(event.currentTarget.closest("[data-rail-order-root],nav")?.querySelectorAll<HTMLElement>("[data-rail-order-id]") ?? [])].filter(item=>item.dataset.railOrderKind === kind && item.dataset.railOrderGroup === group);
      const index = siblings.findIndex(item=>item.dataset.railOrderId === id);
      const target = siblings[index + (event.key === "ArrowUp" ? -1 : 1)]?.dataset.railOrderId;
      event.preventDefault(); event.stopPropagation();
      if (target) order.move(kind,id,target);
    }}>{children}</div>;
}
