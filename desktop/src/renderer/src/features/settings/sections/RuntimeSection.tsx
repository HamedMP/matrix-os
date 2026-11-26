import { Check, LoaderCircle, Monitor, RefreshCw } from "@renderer/lib/hugeicons";
import { useMemo, useEffect } from "react";
import { OwnedComputersPanel, type OwnedComputersTransport } from "@matrix-os/ui/owned-computers";
import {
  matrixComputerAvailabilityLabel,
  type MatrixComputer,
} from "@matrix-os/contracts";
import { Button } from "../../../design/primitives";
import { useConnection } from "../../../stores/connection";
import { useRuntimeComputers } from "../../../stores/runtime-computers";
import { Card, Empty, SettingsSectionHeader } from "./section-kit";

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
      ? `${computer.label} is ${matrixComputerAvailabilityLabel(computer).toLowerCase()}`
      : `Use ${computer.label}`;

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
      style={{
        background: selected ? "var(--accent-muted)" : "var(--bg-raised)",
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
            <span>{matrixComputerAvailabilityLabel(computer)}</span>
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
  const api = useConnection((state) => state.api);
  const userId = useConnection((state) => state.userId);
  // Owned computers are account-scoped platform routes; never add a runtime selector.
  const ownedTransport = useMemo<OwnedComputersTransport | null>(() => {
    if (!api) return null;
    const platform = api.forRuntime("primary");
    return {
      get: (path) => platform.get<unknown>(path, { maxBytes: 16_384 }),
      patch: (path, body) => platform.patch<unknown>(path, body, { maxBytes: 4_096 }),
      remove: async (path) => { await platform.delete<unknown>(path, undefined, { omitErrorBody: true }); },
    };
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [authGeneration, connectionStatus, handle, platformHost, refresh, runtimeSlot]);

  async function switchComputer(computer: MatrixComputer): Promise<void> {
    if (computer.runtimeSlot === selectedSlot || computer.availability !== "available" || switchingSlot) return;
    await selectComputer(computer.runtimeSlot);
  }

  return (
    <>
      <SettingsSectionHeader
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
          <p role="alert" className="text-xs" style={{ color: "var(--danger-text)" }}>
            Couldn&apos;t switch computers. Try again.
          </p>
        ) : null}
      </Card>
      <Card>
        {ownedTransport ? (
          <OwnedComputersPanel scope={JSON.stringify([userId, authGeneration, platformHost])} transport={ownedTransport} onChanged={() => { void refresh({ force: true }); }} />
        ) : (
          <Empty text="Sign in to manage your own computers." />
        )}
      </Card>
    </>
  );
}
