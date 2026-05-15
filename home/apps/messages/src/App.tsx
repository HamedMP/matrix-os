import { useEffect, useMemo, useState } from "react";
import "./styles.css";

type NetworkSlug = "telegram" | "whatsapp";

interface MessagingNetwork {
  slug: NetworkSlug;
  displayName: string;
  setupKind: "qr" | "code" | "api_credentials";
  enabled: boolean;
  requiresExternalCredentials: boolean;
}

interface MessagingAccount {
  id: string;
  networkSlug: NetworkSlug;
  displayName?: string;
  status: "setup_required" | "connecting" | "connected" | "disconnected" | "error";
}

interface SetupSession {
  id: string;
  networkSlug: NetworkSlug;
  status: "pending" | "complete" | "expired" | "cancelled";
  setupUrl?: string;
  qrCode?: string;
  pairingCode?: string;
  expiresAt: string;
}

interface MatrixConversation {
  id: string;
  networkSlug: NetworkSlug;
  displayName: string;
  lastEventAt?: string;
}

const networkTone: Record<NetworkSlug, string> = {
  telegram: "blue",
  whatsapp: "green",
};

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error("request_failed");
  return res.json() as Promise<T>;
}

export default function App() {
  const [networks, setNetworks] = useState<MessagingNetwork[]>([]);
  const [accounts, setAccounts] = useState<MessagingAccount[]>([]);
  const [conversations, setConversations] = useState<MatrixConversation[]>([]);
  const [setupSession, setSetupSession] = useState<SetupSession | null>(null);
  const [activeNetwork, setActiveNetwork] = useState<NetworkSlug | "all">("all");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [busyNetwork, setBusyNetwork] = useState<NetworkSlug | null>(null);

  async function refresh() {
    setStatus("loading");
    try {
      const [networkResult, accountResult, conversationResult] = await Promise.all([
        requestJson<{ networks: MessagingNetwork[] }>("/api/messages/networks"),
        requestJson<{ accounts: MessagingAccount[] }>("/api/messages/accounts"),
        requestJson<{ items: MatrixConversation[] }>("/api/messages/conversations"),
      ]);
      setNetworks(networkResult.networks);
      setAccounts(accountResult.accounts);
      setConversations(conversationResult.items);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const connectedByNetwork = useMemo(() => {
    const latest = new Map<NetworkSlug, MessagingAccount>();
    for (const account of accounts) {
      if (!latest.has(account.networkSlug)) latest.set(account.networkSlug, account);
    }
    return latest;
  }, [accounts]);

  const visibleConversations = useMemo(() => {
    if (activeNetwork === "all") return conversations;
    return conversations.filter((conversation) => conversation.networkSlug === activeNetwork);
  }, [activeNetwork, conversations]);

  async function startSetup(networkSlug: NetworkSlug) {
    setBusyNetwork(networkSlug);
    try {
      const session = await requestJson<SetupSession>("/api/messages/accounts/setup", {
        method: "POST",
        body: JSON.stringify({ networkSlug }),
      });
      setSetupSession(session);
      await refresh();
    } catch {
      setStatus("error");
    } finally {
      setBusyNetwork(null);
    }
  }

  return (
    <main className="messages-app">
      <section className="messages-topbar">
        <div>
          <h1>Messages</h1>
          <p>{accounts.length} connected account{accounts.length === 1 ? "" : "s"}</p>
        </div>
        <button className="icon-button" type="button" onClick={() => void refresh()} aria-label="Refresh messages">
          <span aria-hidden="true">R</span>
        </button>
      </section>

      {status === "error" ? (
        <section className="notice" role="status">
          <strong>Messaging is not available.</strong>
          <span>Gateway setup or Postgres is not ready.</span>
        </section>
      ) : null}

      <section className="network-grid" aria-label="Messaging networks">
        {networks.map((network) => {
          const account = connectedByNetwork.get(network.slug);
          const tone = networkTone[network.slug];
          return (
            <article className={`network-card ${tone}`} key={network.slug}>
              <div className="network-heading">
                <div>
                  <h2>{network.displayName}</h2>
                  <p>{account?.displayName ?? account?.status ?? "Not connected"}</p>
                </div>
                <span className={`status-pill ${account?.status === "connected" ? "connected" : ""}`}>
                  {account?.status ?? "offline"}
                </span>
              </div>
              <button
                className="primary-button"
                type="button"
                disabled={!network.enabled || busyNetwork === network.slug}
                onClick={() => void startSetup(network.slug)}
              >
                {busyNetwork === network.slug ? "Starting" : account ? "Reconnect" : "Connect"}
              </button>
            </article>
          );
        })}
      </section>

      {setupSession ? (
        <section className="setup-panel" aria-label="Current setup session">
          <div>
            <h2>{setupSession.networkSlug === "whatsapp" ? "WhatsApp setup" : "Telegram setup"}</h2>
            <p>Expires {new Date(setupSession.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
          </div>
          {setupSession.qrCode ? <code>{setupSession.qrCode}</code> : null}
          {setupSession.setupUrl ? <a href={setupSession.setupUrl}>{setupSession.setupUrl}</a> : null}
          {setupSession.pairingCode ? <code>{setupSession.pairingCode}</code> : null}
        </section>
      ) : null}

      <section className="conversation-section">
        <div className="section-title">
          <h2>Conversations</h2>
          <div className="segmented" role="tablist" aria-label="Conversation network filter">
            {(["all", "telegram", "whatsapp"] as const).map((filter) => (
              <button
                key={filter}
                className={activeNetwork === filter ? "active" : ""}
                type="button"
                onClick={() => setActiveNetwork(filter)}
              >
                {filter === "all" ? "All" : filter[0].toUpperCase() + filter.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {status === "loading" ? <div className="empty-state">Loading conversations</div> : null}
        {status !== "loading" && visibleConversations.length === 0 ? (
          <div className="empty-state">No bridged conversations yet</div>
        ) : null}
        {visibleConversations.length > 0 ? (
          <div className="conversation-list">
            {visibleConversations.map((conversation) => (
              <article className="conversation-row" key={conversation.id}>
                <span className={`network-dot ${networkTone[conversation.networkSlug]}`} aria-hidden="true" />
                <div>
                  <h3>{conversation.displayName}</h3>
                  <p>{conversation.networkSlug}</p>
                </div>
                <time>{conversation.lastEventAt ? new Date(conversation.lastEventAt).toLocaleDateString() : ""}</time>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}
