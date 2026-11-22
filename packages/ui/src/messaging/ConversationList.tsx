import { MessagesSquare } from "lucide-react";
import type { MessagingBridgeConversation, MessagingBridgeNetwork } from "@matrix-os/contracts/messaging-bridge";
import { Badge } from "../Badge.js";
import { Button } from "../Button.js";
import { filterConversations, formatMessageTime, networkLabel, type ConversationFilter } from "./bridge-view.js";
import { chatAppsStyles as s } from "./chat-apps-styles.js";

export interface ConversationListState {
  items: MessagingBridgeConversation[];
  nextCursor?: string;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

export interface ConversationListProps {
  networks: MessagingBridgeNetwork[];
  filter: ConversationFilter;
  list: ConversationListState;
  onFilter: (filter: ConversationFilter) => void;
  onOpen: (conversation: MessagingBridgeConversation) => void;
  onRetry: () => void;
  onMore: () => void;
}

export function ConversationList({ networks, filter, list, onFilter, onOpen, onRetry, onMore }: ConversationListProps) {
  const visible = filterConversations(list.items, filter);
  const filterLabel = filter === "all" ? "" : `${networkLabel(filter)} `;
  return (
    <div className="ph-no-capture" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {networks.length > 1 ? (
        <div role="group" aria-label="Filter conversations by app" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(["all", ...networks] as ConversationFilter[]).map((option) => (
            <Button key={option} size="sm" variant={option === filter ? "primary" : "secondary"} aria-pressed={option === filter} onClick={() => onFilter(option)}>
              {option === "all" ? "All" : networkLabel(option)}
            </Button>
          ))}
        </div>
      ) : null}
      <div style={{ ...s.card, minHeight: 240, display: "flex", flexDirection: "column" }} aria-busy={list.loading}>
        {list.loading && list.items.length === 0 ? <p role="status" style={{ ...s.muted, padding: 16 }}>Loading conversations…</p> : null}
        {!list.loading && visible.length === 0 && !list.error ? (
          <div style={s.empty}>
            <MessagesSquare size={22} aria-hidden="true" />
            <p style={{ ...s.body, fontWeight: 600 }}>No {filterLabel}conversations yet</p>
            <p style={s.muted}>New chats from your connected apps appear here as messages arrive. Send or receive a message in the app to start.</p>
          </div>
        ) : null}
        {list.error ? (
          <div role="alert" style={{ ...s.alert, margin: 12 }}>
            <span>{list.error}</span>
            <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>
          </div>
        ) : null}
        {visible.length > 0 ? (
          <ul aria-label="Conversations" style={{ listStyle: "none", margin: 0, padding: 4 }}>
            {visible.map((item) => <ConversationRow key={item.roomId} conversation={item} onOpen={() => onOpen(item)} />)}
          </ul>
        ) : null}
        {list.nextCursor && visible.length > 0 ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 8 }}>
            <Button variant="ghost" size="sm" disabled={list.loadingMore} onClick={onMore}>
              {list.loadingMore ? "Loading…" : "Show more"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConversationRow({ conversation, onOpen }: { conversation: MessagingBridgeConversation; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${conversation.displayName}, ${networkLabel(conversation.network)}${conversation.unreadCount > 0 ? `, ${conversation.unreadCount} unread` : ""}`}
        className="matrix-btn matrix-btn-ghost"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 12px",
          border: "none",
          borderRadius: "var(--matrix-radius-md, 8px)",
          background: "transparent",
          color: "inherit",
          textAlign: "left",
          cursor: "pointer",
          fontFamily: "var(--matrix-font-sans)",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ ...s.body, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{conversation.displayName}</span>
            <Badge>{networkLabel(conversation.network)}</Badge>
          </span>
          {conversation.lastMessagePreview ? (
            <span style={{ ...s.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{conversation.lastMessagePreview}</span>
          ) : null}
        </span>
        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <span style={{ ...s.muted, fontSize: "0.75rem" }}>{formatMessageTime(conversation.lastEventAt)}</span>
          {conversation.unreadCount > 0 ? <Badge variant="success">{conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</Badge> : null}
        </span>
      </button>
    </li>
  );
}
