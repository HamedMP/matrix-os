import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function MessagesApp() {
  return (
    <main style={{
      minHeight: "100vh",
      padding: "24px",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      background: "var(--matrix-bg, #0f1419)",
      color: "var(--matrix-fg, #eef2f6)",
    }}>
      <h1 style={{ fontSize: "24px", margin: 0 }}>Messages</h1>
      <p style={{ maxWidth: "560px", lineHeight: 1.5 }}>
        Telegram and WhatsApp bridge setup will appear here after the gateway
        messaging contracts are implemented.
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MessagesApp />
  </StrictMode>,
);
