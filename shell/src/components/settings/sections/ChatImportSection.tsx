"use client";
import { useMemo } from "react";
import { ChatImportPanel } from "@matrix-os/ui";
import { createLocalChatHttpTransport } from "@matrix-os/contracts/local-chat-import";
import { getGatewayUrl } from "@/lib/gateway";
export function ChatImportSection({ onOpenChat }: {
    onOpenChat?: (chatId: string) => void;
}) {
    const gatewayUrl = getGatewayUrl();
    const transport = useMemo(() => createLocalChatHttpTransport({ baseUrl: gatewayUrl || window.location.origin, headers: () => ({}), credentials: "include" }), [gatewayUrl]);
    return <div className="p-6"><ChatImportPanel key={gatewayUrl} transport={transport} onOpenChat={onOpenChat ? (chatId) => onOpenChat(chatId) : undefined}/></div>;
}
