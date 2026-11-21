import { useState } from "react";
import { ComputerAddIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "../Button.js";
import type { JoinCodeResponse, PairedMachine, PrivateNetworkClient } from "./client.js";
import { ConfirmDialog, CopyButton, FeedbackLine } from "./parts.js";
import { expiryLabel, formatPairedDate, isSafeLinkUrl, linkStyle, minutesLeft, mutedText, onlineLabel } from "./presentation.js";
import { usePairedMachines } from "./use-paired-machines.js";

const rowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  padding: "10px 12px",
  border: "1px solid var(--matrix-border)",
  borderRadius: "var(--matrix-radius-md)",
} as const;

function OnlineDot({ online }: { online: boolean | null }) {
  const color = online === true ? "var(--matrix-success)" : online === false ? "var(--matrix-muted-fg)" : "transparent";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", ...mutedText }}>
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: 9999, background: color, border: "1px solid var(--matrix-muted-fg)" }}
      />
      {onlineLabel(online)}
    </span>
  );
}

function MachineRow({ machine, onRemove, busy }: { machine: PairedMachine; onRemove(): void; busy: boolean }) {
  return (
    <li style={rowStyle}>
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" }}>
        <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>{machine.name}</span>
        {isSafeLinkUrl(machine.url) ? (
          <a href={machine.url} target="_blank" rel="noopener noreferrer" style={{ ...linkStyle, fontSize: "0.8125rem" }}>
            {machine.dnsName}
          </a>
        ) : (
          <span style={mutedText}>{machine.dnsName}</span>
        )}
        <span style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
          <OnlineDot online={machine.online} />
          <span style={mutedText}>Paired {formatPairedDate(machine.pairedAt)}</span>
        </span>
      </div>
      <Button variant="secondary" size="sm" aria-label={`Remove ${machine.name}`} onClick={onRemove} disabled={busy}>
        Remove
      </Button>
    </li>
  );
}

function JoinCodeSteps({ joinCode, now }: { joinCode: JoinCodeResponse; now: number }) {
  const expired = minutesLeft(joinCode.expiresAt, now) === 0;
  return (
    <div style={{ ...rowStyle, flexDirection: "column", gap: "8px", alignItems: "stretch" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>Join command</span>
        <span style={mutedText}>{expiryLabel(joinCode.expiresAt, now)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
        <pre
          aria-label="Join command"
          style={{
            flex: 1,
            margin: 0,
            padding: "8px 10px",
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            fontFamily: "var(--matrix-font-mono, ui-monospace, monospace)",
            fontSize: "0.75rem",
            background: "var(--matrix-muted)",
            borderRadius: "var(--matrix-radius-md)",
            opacity: expired ? 0.5 : 1,
          }}
        >
          <code>{joinCode.command}</code>
        </pre>
        <CopyButton text={joinCode.command} label="Copy command" />
      </div>
      <ol style={{ ...mutedText, paddingLeft: "1.25rem" }}>
        <li>Run it on the second server.</li>
        <li>Open the login link it prints and sign in with the same Tailscale account.</li>
        <li>The machine appears here.</li>
      </ol>
    </div>
  );
}

export function PairedMachinesSection({ client }: { client: PrivateNetworkClient }) {
  const machines = usePairedMachines(client);
  const [pendingRemoval, setPendingRemoval] = useState<PairedMachine | null>(null);
  const rows = machines.list?.machines ?? [];

  const addButton = (
    <Button variant="secondary" size="sm" onClick={() => void machines.createJoinCode()} disabled={machines.creatingJoinCode}>
      <HugeiconsIcon icon={ComputerAddIcon} size={14} strokeWidth={1.6} aria-hidden />
      Add a machine
    </Button>
  );

  return (
    <section aria-label="Machines" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <h4 style={{ margin: 0, fontSize: "0.9375rem", fontWeight: 600 }}>Machines</h4>
        {rows.length > 0 && addButton}
      </div>
      {machines.joinCode && <JoinCodeSteps joinCode={machines.joinCode} now={machines.now} />}
      {machines.loading && !machines.list ? (
        <p style={mutedText}>Loading machines…</p>
      ) : rows.length === 0 && machines.list ? (
        <div style={{ ...rowStyle, flexDirection: "column", alignItems: "center", textAlign: "center", padding: "20px 16px" }}>
          <HugeiconsIcon icon={ComputerAddIcon} size={28} strokeWidth={1.4} aria-hidden />
          <p style={{ margin: 0, fontWeight: 600, fontSize: "0.875rem" }}>No other machines yet</p>
          <p style={mutedText}>Add another server to your private network to open Matrix on it from here.</p>
          {!machines.joinCode && addButton}
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "8px" }}>
          {rows.map((machine) => (
            <MachineRow
              key={machine.id}
              machine={machine}
              busy={machines.removingId !== null}
              onRemove={() => setPendingRemoval(machine)}
            />
          ))}
        </ul>
      )}
      {!machines.list && !machines.loading && (
        <div>
          <Button variant="secondary" size="sm" onClick={machines.reload}>
            Retry
          </Button>
        </div>
      )}
      <FeedbackLine message={machines.error} />
      <ConfirmDialog
        open={pendingRemoval !== null}
        title={`Remove ${pendingRemoval?.name ?? "machine"}?`}
        confirmLabel="Remove"
        busy={machines.removingId !== null}
        onClose={() => setPendingRemoval(null)}
        onConfirm={() => {
          const target = pendingRemoval;
          if (!target) return;
          void machines.removeMachine(target.id).then(() => setPendingRemoval(null));
        }}
      >
        <p style={{ margin: 0 }}>
          It will no longer be paired with this computer. You can add it again later with a new join code.
        </p>
      </ConfirmDialog>
    </section>
  );
}
