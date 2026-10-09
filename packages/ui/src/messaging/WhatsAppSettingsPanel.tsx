import { useEffect, useRef, useState } from "react";
import {
  WhatsAppSettingsSchema,
  whatsAppSettingsView,
  WHATSAPP_CONNECT_URL,
  WHATSAPP_GUIDE_URL,
  WHATSAPP_AI_GUIDANCE,
  WHATSAPP_AGENT_GUIDANCE,
  whatsAppChatUrl,
  type WhatsAppSettings,
} from "@matrix-os/contracts";

export function WhatsAppSettingsPanel(props: {
  scope: string;
  load: () => Promise<unknown>;
  onOpen?: (url: string) => Promise<void>;
}) {
  return <OwnerWhatsAppSettings key={props.scope} {...props} />;
}
function OwnerWhatsAppSettings({
  load,
  onOpen,
}: {
  load: () => Promise<unknown>;
  onOpen?: (url: string) => Promise<void>;
}) {
  const [loaded, setSnapshot] = useState<WhatsAppSettings | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const loadRef = useRef(load);
  const busy = useRef(false);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    let active = true;
    busy.current = true;
    setSnapshot(null);
    setError(false);
    void loadRef
      .current()
      .then((value) => {
        if (active) setSnapshot(WhatsAppSettingsSchema.parse(value));
      })
      .catch((error: unknown) => {
        console.warn(
          "[messaging] Connection unavailable",
          error instanceof Error ? error.name : "UnknownError",
        );
        if (active) {
          setSnapshot(null);
          setError(true);
        }
      })
      .finally(() => {
        if (active) busy.current = false;
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  useEffect(() => {
    const returned = () => {
      if (!busy.current && document.visibilityState === "visible") {
        busy.current = true;
        setRefresh((x) => x + 1);
      }
    };
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    return () => {
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", returned);
    };
  }, []);
  const { snapshot, label } = whatsAppSettingsView(
    loaded,
    !loaded && !error,
    error,
  );
  const open = async (url: string) => {
    try {
      await onOpen?.(url);
    } catch (error) {
      console.warn(
        "[messaging] Browser unavailable",
        error instanceof Error ? error.name : "UnknownError",
      );
      setError(true);
    }
  };
  const link = (label: string, url: string, primary = false) => (
    <a
      href={url}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 44,
        padding: "10px 14px",
        border: "1px solid var(--matrix-border, var(--border))",
        borderRadius: 10,
        fontSize: 14,
        fontWeight: 500,
        textDecoration: "none",
        background: primary
          ? "var(--matrix-accent, var(--primary))"
          : "transparent",
        color: primary
          ? "var(--matrix-accent-fg, var(--primary-foreground))"
          : "inherit",
      }}
      target="_blank"
      rel="noopener noreferrer"
      onClick={
        onOpen
          ? (event) => {
              event.preventDefault();
              void open(url);
            }
          : undefined
      }
    >
      {label}
    </a>
  );
  return (
    <section
      aria-label="WhatsApp"
      style={{
        border: "1px solid var(--matrix-border, var(--border))",
        borderRadius: 14,
        padding: 24,
        marginBottom: 24,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <h3 style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 18, fontWeight: 600, margin: 0 }}>
          <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 21l1.9-5.5a9 9 0 0 1-.9-4A8.5 8.5 0 0 1 12.5 3H13a8.5 8.5 0 0 1 8 8v.5Z" />
            <path d="M9 7.5 8 9c.6 3.1 2.5 5 5.6 5.6l1.5-1-2-1.8-.8.6a5 5 0 0 1-2.7-2.7l.6-.8L9 7.5Z" />
          </svg>
          WhatsApp
        </h3>
        <span role="status" style={{ fontSize: 12, fontWeight: 500, padding: "5px 10px", borderRadius: 999, border: "1px solid var(--matrix-border, var(--border))", whiteSpace: "nowrap" }}>{label}</span>
      </div>
      <p style={{ lineHeight: 1.6, margin: "12px 0" }}>
        Your personal Matrix assistant, one message away. Conversations stay
        in your private Matrix Chat.
      </p>
      {snapshot?.connected && <p style={{ fontSize: 14, margin: "12px 0" }}>Linked account · {snapshot.maskedSender}</p>}
      {snapshot?.admission === "pilot" && (
        <p style={{ fontSize: 13, margin: "12px 0" }}>Early access · Available to invited accounts.</p>
      )}
      <p style={{ lineHeight: 1.6, margin: "12px 0" }}>
        {WHATSAPP_AI_GUIDANCE}
      </p>
      <p style={{ lineHeight: 1.6, fontSize: 14, margin: "12px 0" }}>{WHATSAPP_AGENT_GUIDANCE}</p>
      {error ? (
        <div role="alert">
          <p>Could not check your connection. Try again.</p>
          <button type="button" onClick={() => setRefresh((x) => x + 1)}>
            Try again
          </button>
        </div>
      ) : null}
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 20 }}
      >
        {snapshot?.startUrl && link("Open WhatsApp", snapshot.startUrl, true)}
        {snapshot?.chatId && link("Open Matrix Chat", whatsAppChatUrl(snapshot.chatId))}
        {snapshot &&
          snapshot.admission !== "unavailable" &&
          link(
            snapshot.connected ? "Manage connection" : "Connect WhatsApp",
            WHATSAPP_CONNECT_URL,
          )}
        {link("Connection guide", WHATSAPP_GUIDE_URL)}
      </div>
      {snapshot &&
        !snapshot.connected &&
        snapshot.admission !== "unavailable" && (
          <p style={{ lineHeight: 1.6, marginTop: 20 }}>
            Send hi to Matrix in WhatsApp, open the connection link you receive,
            then confirm the code. Send STOP anytime to disconnect.
          </p>
        )}
    </section>
  );
}
