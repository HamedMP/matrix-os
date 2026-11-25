import { useEffect, useRef, useState } from "react";
import { MessagesSquare } from "lucide-react";
import {
  MESSAGING_BRIDGE_NETWORKS,
  type MessagingBridgeChangedEvent,
  type MessagingBridgeNetwork,
  type MessagingBridgeStatus,
} from "@matrix-os/contracts/messaging-bridge";
import { Badge } from "../Badge.js";
import { Button } from "../Button.js";
import { Dialog } from "../Dialog.js";
import { DialogFooter } from "../DialogFooter.js";
import { DialogTitle } from "../DialogTitle.js";
import {
  bridgeErrorText,
  createMessagingBridgeClient,
  isBridgeAbort,
  MessagingBridgeClientError,
  type MessagingBridgeClient,
  type MessagingBridgeFetch,
} from "./bridge-client.js";
import { deriveChatAppsSection, type ChatAppAccountRow, type ChatAppNetworkRow, type ChatAppsSectionState } from "./bridge-view.js";
import { chatAppsStyles as s } from "./chat-apps-styles.js";
import { ChatInbox } from "./ChatInbox.js";
import { LinkAccountDialog } from "./LinkAccountDialog.js";
import { useMessagingBridgeChanges, type MessagingBridgeSubscribe } from "./use-bridge-changes.js";

export interface ChatAppsPanelProps {
  /** Changes when the signed-in owner, session or runtime changes; remounts all state. */
  scope: string;
  /** Surface adapter: authenticated same-origin fetch, or `null` while no runtime is connected. */
  fetch: MessagingBridgeFetch | null;
  /** Surface adapter: owner WebSocket subscription. Omitted or `null` result falls back to polling. */
  subscribe?: MessagingBridgeSubscribe;
  /** Surface adapter: whether the owner WebSocket is live right now; `false` polls and refreshes on reconnect. */
  connected?: boolean;
  /** Surface adapter: bumped on every owner WebSocket open; a change refreshes everything once. */
  connectionEpoch?: number;
  onOpenExternal?: (url: string) => Promise<void> | void;
}

export function ChatAppsPanel(props: ChatAppsPanelProps) {
  return (
    <section
      aria-labelledby="chat-apps-heading"
      style={{ marginTop: 32, paddingTop: 24, borderTop: "1px solid var(--matrix-border, var(--border))", display: "flex", flexDirection: "column", gap: 16 }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h3 id="chat-apps-heading" style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Your chat apps</h3>
        <p style={s.muted}>Link your own WhatsApp, Telegram and LinkedIn accounts to read and answer your conversations in Matrix.</p>
      </div>
      {props.fetch ? (
        <ChatAppsContent
          key={props.scope}
          fetch={props.fetch}
          subscribe={props.subscribe}
          connected={props.connected ?? true}
          connectionEpoch={props.connectionEpoch ?? 0}
          onOpenExternal={props.onOpenExternal}
        />
      ) : (
        <div role="alert" style={s.alert}><span>Connect to your Matrix computer to manage chat apps.</span></div>
      )}
    </section>
  );
}

type RemoveTarget = { network: MessagingBridgeNetwork; account: ChatAppAccountRow; busy: boolean; error: string | null };

function ChatAppsContent({
  fetch,
  subscribe,
  connected,
  connectionEpoch,
  onOpenExternal,
}: {
  fetch: MessagingBridgeFetch;
  subscribe?: MessagingBridgeSubscribe;
  connected: boolean;
  connectionEpoch: number;
  onOpenExternal?: (url: string) => Promise<void> | void;
}) {
  const fetchRef = useRef(fetch);
  const [client] = useState<MessagingBridgeClient>(() => createMessagingBridgeClient((path, init) => fetchRef.current(path, init)));
  const [status, setStatus] = useState<MessagingBridgeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState<{ network: MessagingBridgeNetwork; attempt: number } | null>(null);
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);
  const statusRequest = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });

  useEffect(() => {
    fetchRef.current = fetch;
  }, [fetch]);
  useEffect(() => () => statusRequest.current.controller?.abort(), []);

  /** `foreground` reads clear the error and report failure; background refreshes keep the last state. */
  const loadStatus = async (foreground: boolean) => {
    statusRequest.current.controller?.abort();
    const controller = new AbortController();
    const generation = statusRequest.current.generation + 1;
    statusRequest.current = { generation, controller };
    if (foreground) setError(null);
    try {
      const next = await client.status(controller.signal);
      if (statusRequest.current.generation !== generation) return;
      setStatus(next);
      setError(null);
    } catch (caught: unknown) {
      if (isBridgeAbort(caught) || statusRequest.current.generation !== generation) return;
      console.warn("[messaging] Chat apps status unavailable", caught instanceof MessagingBridgeClientError ? caught.code : "UnknownError");
      if (foreground) setError(bridgeErrorText(caught));
    }
  };

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- one bootstrap status read per mounted owner scope, bounded by the client's 10 s timeout and aborted on unmount; later reads follow user actions and owner-socket change events
  useEffect(() => {
    void loadStatus(true);
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- mount-only bootstrap; loadStatus reads refs and the client, which is fixed for this mount
  }, []);

  useMessagingBridgeChanges(subscribe, (event: MessagingBridgeChangedEvent | null) => {
    if (event === null || event.scope === "accounts") void loadStatus(false);
  }, true, connected, connectionEpoch);

  const confirmRemove = async (target: RemoveTarget) => {
    setRemoving({ ...target, busy: true, error: null });
    try {
      await client.removeAccount(target.network, target.account.accountId);
    } catch (caught: unknown) {
      setRemoving({ ...target, busy: false, error: bridgeErrorText(caught) });
      return;
    }
    // The server confirmed: drop the row now, then re-read the authoritative state.
    setStatus((prev) =>
      prev
        ? {
            ...prev,
            networks: prev.networks.map((entry) =>
              entry.network === target.network ? { ...entry, accounts: entry.accounts.filter((a) => a.accountId !== target.account.accountId) } : entry,
            ),
          }
        : prev,
    );
    setRemoving(null);
    void loadStatus(false);
  };

  const view = deriveChatAppsSection({ status, loading: status === null && error === null, error });

  return (
    <>
      <StatusNotice view={view} onRetry={() => { void loadStatus(true); }} />
      {view.kind === "ready" ? (
        <ul aria-label="Chat apps" style={{ ...s.card, listStyle: "none", margin: 0, padding: 0 }}>
          {view.rows.map((row, index) => (
            <NetworkRow
              key={row.network}
              row={row}
              first={index === 0}
              onLink={() => setLinking((prev) => ({ network: row.network, attempt: (prev?.attempt ?? 0) + 1 }))}
              onRemove={(account) => setRemoving({ network: row.network, account, busy: false, error: null })}
            />
          ))}
        </ul>
      ) : null}
      {/* One inbox across ready, outage and error states keeps the open thread, drafts and failed sends. */}
      {view.kind === "ready" || view.kind === "unavailable" || view.kind === "error" ? (
        <ChatInbox client={client} subscribe={subscribe} connected={connected} connectionEpoch={connectionEpoch}
          networks={view.kind === "ready" ? view.rows.map((row) => row.network) : [...MESSAGING_BRIDGE_NETWORKS]}
          hasAccounts={view.kind === "ready" ? view.hasAccounts : true} />
      ) : null}
      {linking ? (
        <LinkAccountDialog
          key={`${linking.network}:${linking.attempt}`}
          network={linking.network}
          client={client}
          onOpenExternal={onOpenExternal}
          onClose={() => setLinking(null)}
          onLinked={() => {
            setLinking(null);
            void loadStatus(false);
          }}
        />
      ) : null}
      {removing ? (
        <Dialog open onClose={() => { if (!removing.busy) setRemoving(null); }} aria-label={`Remove ${removing.account.label}`}>
          <DialogTitle>Remove {removing.account.label}?</DialogTitle>
          <p style={s.body}>Matrix will disconnect this account. Conversations already in Matrix stay readable, and you can connect it again later.</p>
          {removing.error ? <p role="alert" style={{ ...s.body, marginTop: 12, color: "var(--matrix-destructive)" }}>{removing.error}</p> : null}
          <DialogFooter>
            <Button variant="secondary" disabled={removing.busy} onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="destructive" disabled={removing.busy} onClick={() => { void confirmRemove(removing); }}>
              {removing.busy ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </Dialog>
      ) : null}
    </>
  );
}

function NetworkRow({
  row,
  first,
  onLink,
  onRemove,
}: {
  row: ChatAppNetworkRow;
  first: boolean;
  onLink: () => void;
  onRemove: (account: ChatAppAccountRow) => void;
}) {
  return (
    <li
      aria-label={row.label}
      style={{ padding: "14px 16px", borderTop: first ? "none" : "1px solid var(--matrix-border, var(--border))", display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div style={s.row}>
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ ...s.body, fontWeight: 600 }}>{row.label}</span>
          {row.accounts.length === 0 ? <span style={s.muted}>Not connected</span> : null}
        </span>
        {row.action ? (
          <Button size="sm" variant={row.action === "connect" ? "primary" : "secondary"} onClick={onLink} aria-label={`${row.action === "connect" ? "Connect" : "Reconnect"} ${row.label}`}>
            {row.action === "connect" ? "Connect" : "Reconnect"}
          </Button>
        ) : null}
      </div>
      {row.accounts.map((account) => (
        <div key={account.accountId} style={s.row}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ ...s.body, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.label}</span>
            <Badge variant={account.tone === "default" ? "default" : account.tone}>{account.stateLabel}</Badge>
          </span>
          <Button variant="ghost" size="sm" onClick={() => onRemove(account)} aria-label={`Remove ${account.label}`}>Remove</Button>
        </div>
      ))}
    </li>
  );
}

/** The loading, error, early-access and outage notices above the account rows. */
function StatusNotice({ view, onRetry }: { view: ChatAppsSectionState; onRetry: () => void }) {
  if (view.kind === "loading") {
    return <div aria-busy="true" style={{ ...s.card, padding: 16, minHeight: 120 }}><p role="status" style={s.muted}>Checking your chat apps…</p></div>;
  }
  if (view.kind === "not_enabled") {
    return (
      <div style={{ ...s.card, ...s.empty, minHeight: 120 }}>
        <MessagesSquare size={22} aria-hidden="true" />
        <p style={{ ...s.body, fontWeight: 600 }}>Not available yet</p>
        <p style={s.muted}>Linking your own chat apps is in early access. It will appear here when your account is included.</p>
      </div>
    );
  }
  if (view.kind !== "error" && view.kind !== "unavailable") return null;
  return (
    <div role="alert" style={s.alert}>
      <span>{view.kind === "error" ? view.message : "Chat apps are unavailable right now. Your saved messages are safe."}</span>
      <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>
    </div>
  );
}
