import { useState } from "react";
import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "../Badge.js";
import { Button } from "../Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../Card.js";
import type { PrivateNetworkClient, PrivateNetworkStatus } from "./client.js";
import { PairedMachinesSection } from "./PairedMachinesSection.js";
import { ConfirmDialog, CopyButton, FeedbackLine } from "./parts.js";
import { PRIVATE_NETWORK_ERRORS, isSafeLinkUrl, linkStyle, mutedText, stateCopy } from "./presentation.js";
import { usePrivateNetworkStatus, type PrivateNetworkStatusModel } from "./use-private-network-status.js";

const detailRow = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", fontSize: "0.875rem" } as const;

function NeedsLogin({ status, model }: { status: PrivateNetworkStatus; model: PrivateNetworkStatusModel }) {
  if (model.loginTimedOut || !isSafeLinkUrl(status.loginUrl)) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-start" }}>
        <p style={mutedText}>{PRIVATE_NETWORK_ERRORS.loginTimedOut}</p>
        <Button onClick={() => void model.connect()} disabled={model.action !== null}>
          Connect
        </Button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-start" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
        <a
          href={status.loginUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="matrix-btn matrix-btn-primary"
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "8px 20px",
            fontSize: "0.875rem",
            fontWeight: 600,
            borderRadius: "var(--matrix-radius-md)",
            background: "var(--matrix-primary)",
            color: "var(--matrix-primary-fg)",
            textDecoration: "none",
          }}
        >
          Open login page
        </a>
        <CopyButton text={status.loginUrl} label="Copy login link" />
      </div>
      <p role="status" style={mutedText}>
        Waiting for you to finish signing in…
      </p>
    </div>
  );
}

function ConnectedDetails({ status }: { status: PrivateNetworkStatus }) {
  const machine = status.machine;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      {status.tailnet && (
        <div style={detailRow}>
          <span style={mutedText}>Network</span>
          <span>{status.tailnet}</span>
        </div>
      )}
      {machine && (
        <div style={detailRow}>
          <span style={mutedText}>This machine</span>
          <span>{machine.name}</span>
        </div>
      )}
      {machine && isSafeLinkUrl(machine.url) && (
        <div style={detailRow}>
          <span style={mutedText}>Private address</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
            <a href={machine.url} target="_blank" rel="noopener noreferrer" style={linkStyle}>
              {machine.dnsName}
            </a>
            <CopyButton text={machine.url} label="Copy private address" />
          </span>
        </div>
      )}
    </div>
  );
}

function StateBody({ status, model, onDisconnect }: { status: PrivateNetworkStatus; model: PrivateNetworkStatusModel; onDisconnect(): void }) {
  const busy = model.action !== null;
  switch (status.state) {
    case "logged-out":
    case "stopped":
      return (
        <div>
          <Button onClick={() => void model.connect()} disabled={busy}>
            {model.action === "connect" ? "Connecting…" : "Connect"}
          </Button>
        </div>
      );
    case "needs-login":
      return <NeedsLogin status={status} model={model} />;
    case "connected":
      return (
        <>
          <ConnectedDetails status={status} />
          <div>
            <Button variant="secondary" onClick={onDisconnect} disabled={busy}>
              Disconnect
            </Button>
          </div>
        </>
      );
    case "unavailable":
      return (
        <div>
          <Button variant="secondary" onClick={model.retry}>
            Retry
          </Button>
        </div>
      );
    default:
      return null;
  }
}

/** Private network (Tailscale/Headscale) controls for self-hosted Matrix computers. */
export function PrivateNetworkPanel({ client }: { client: PrivateNetworkClient }) {
  const model = usePrivateNetworkStatus(client);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const { phase, status } = model;
  // A brief status failure must not unmount pairing and lose a valid join code.
  const [pairingMounted, setPairingMounted] = useState(false);
  const keepPairing = status?.state === "connected" || (pairingMounted && status?.state === "unavailable");
  if (keepPairing !== pairingMounted) setPairingMounted(keepPairing);
  if (phase === "hidden" || phase === "loading") return null;
  const visibleState = status && status.state !== "unsupported" ? status.state : null;
  const copy = visibleState ? stateCopy(visibleState) : null;

  return (
    <Card>
      <CardHeader style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <CardTitle style={{ fontSize: "0.9375rem", display: "flex", alignItems: "center", gap: "8px" }}>
          <HugeiconsIcon icon={ServerStack01Icon} size={16} strokeWidth={1.6} aria-hidden />
          Private network
        </CardTitle>
        {copy && <Badge variant={copy.variant}>{copy.badge}</Badge>}
      </CardHeader>
      <CardContent style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {phase === "failed" || !status ? (
          <div>
            <Button variant="secondary" onClick={model.retry}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            {copy && <p style={mutedText}>{copy.description}</p>}
            <StateBody status={status} model={model} onDisconnect={() => setConfirmingDisconnect(true)} />
          </>
        )}
        <FeedbackLine message={model.error} />
        {keepPairing && <PairedMachinesSection client={client} />}
      </CardContent>
      <ConfirmDialog
        open={confirmingDisconnect}
        title="Disconnect from the private network?"
        confirmLabel="Disconnect"
        busy={model.action === "disconnect"}
        onClose={() => setConfirmingDisconnect(false)}
        onConfirm={() => {
          void model.disconnect().then(() => setConfirmingDisconnect(false));
        }}
      >
        <p style={{ margin: 0 }}>Other devices on your private network will no longer reach this computer.</p>
        {status?.viaPrivateNetwork && (
          <p style={{ margin: 0, fontWeight: 600, color: "var(--matrix-destructive)" }}>
            This page is reached over the private network. Disconnecting cuts your access here until you reconnect from
            the server, for example with sudo tailscale up.
          </p>
        )}
      </ConfirmDialog>
    </Card>
  );
}
