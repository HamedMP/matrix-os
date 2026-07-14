import { Check, LoaderCircle, Monitor, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import {
  type MatrixComputer,
} from "@matrix-os/contracts";
import { Button } from "../../../design/primitives";
import { useConnection } from "../../../stores/connection";
import { useRuntimeComputers } from "../../../stores/runtime-computers";
import { Card, Empty, SectionHeader } from "./section-kit";

const STATUS_LABEL: Record<MatrixComputer["availability"], string> = {
  available: "Available",
  starting: "Starting",
  unavailable: "Unavailable",
};

function ComputerCard({
  computer,
  selected,
  switching,
  onSelect,
}: {
  computer: MatrixComputer;
  selected: boolean;
  switching: boolean;
  onSelect: (computer: MatrixComputer) => void;
}) {
  const unavailable = computer.availability !== "available";
  const buttonLabel = selected
    ? "Current computer"
    : unavailable
      ? `${computer.label} is ${computer.availability}`
      : `Use ${computer.label}`;

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
      style={{
        background: selected ? "var(--accent-muted)" : "var(--bg-elevated)",
        borderColor: selected ? "var(--accent)" : "var(--border-subtle)",
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          style={{
            background: selected ? "var(--accent)" : "var(--bg-hover)",
            color: selected ? "var(--text-on-accent)" : "var(--text-secondary)",
          }}
        >
          <Monitor size={17} aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
              {computer.label}
            </span>
            {selected ? <Check size={14} style={{ color: "var(--accent)" }} aria-hidden="true" /> : null}
          </div>
          <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
            <span className="truncate">{computer.handle}</span>
            <span aria-hidden="true">·</span>
            <span>{STATUS_LABEL[computer.availability]}</span>
          </div>
        </div>
      </div>
      <Button
        variant={selected ? "ghost" : "subtle"}
        className="shrink-0 justify-center"
        disabled={selected || unavailable || switching}
        aria-label={buttonLabel}
        onClick={() => onSelect(computer)}
      >
        {switching ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : null}
        {switching ? "Switching…" : selected ? "Current" : "Use"}
      </Button>
    </div>
  );
}

export default function RuntimeSection() {
  const connectionStatus = useConnection((state) => state.status);
  const handle = useConnection((state) => state.handle);
  const platformHost = useConnection((state) => state.platformHost);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const loadState = useRuntimeComputers((state) => state.status);
  const computers = useRuntimeComputers((state) => state.computers);
  const serverSelectedSlot = useRuntimeComputers((state) => state.runtimeSlot);
  const switchingSlot = useRuntimeComputers((state) => state.switchingSlot);
  const switchError = useRuntimeComputers((state) => state.switchError);
  const refresh = useRuntimeComputers((state) => state.refresh);
  const selectComputer = useRuntimeComputers((state) => state.select);
  // The inventory response's selectedSlot reflects the credential in use; the
  // persisted profile slot is only a fallback until the first refresh lands.
  const selectedSlot = serverSelectedSlot ?? runtimeSlot;

  useEffect(() => {
    void refresh();
  }, [authGeneration, connectionStatus, handle, platformHost, refresh, runtimeSlot]);

  async function switchComputer(computer: MatrixComputer): Promise<void> {
    if (computer.runtimeSlot === selectedSlot || computer.availability !== "available" || switchingSlot) return;
    await selectComputer(computer.runtimeSlot);
  }

  return (
    <>
      <SectionHeader
        title="Computers"
        description="Choose the Matrix computer this desktop app connects to."
      />
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Your computers</p>
            <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
              Chats, tasks, files, and terminals follow the selected computer.
            </p>
          </div>
          <Button
            variant="ghost"
            aria-label="Refresh computers"
            disabled={loadState === "loading"}
            onClick={() => void refresh({ force: true })}
          >
            <RefreshCw size={14} className={loadState === "loading" ? "animate-spin" : ""} aria-hidden="true" />
            Refresh
          </Button>
        </div>

        {loadState === "loading" ? (
          <div className="flex items-center gap-2 py-3 text-sm" style={{ color: "var(--text-tertiary)" }}>
            <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
            Loading computers…
          </div>
        ) : null}

        {loadState === "error" ? <Empty text="Computers are unavailable right now." /> : null}
        {loadState === "ready" && computers.length === 0 ? <Empty text="No computers are available yet." /> : null}

        {loadState === "ready" ? (
          <div className="flex flex-col gap-2">
            {computers.map((computer) => (
              <ComputerCard
                key={computer.runtimeSlot}
                computer={computer}
                selected={computer.runtimeSlot === selectedSlot}
                switching={switchingSlot === computer.runtimeSlot}
                onSelect={(next) => {
                  void switchComputer(next);
                }}
              />
            ))}
          </div>
        ) : null}

        {switchError ? (
          <p role="alert" className="text-xs" style={{ color: "var(--danger)" }}>
            Couldn&apos;t switch computers. Try again.
          </p>
        ) : null}
      </Card>
    </>
  );
}
