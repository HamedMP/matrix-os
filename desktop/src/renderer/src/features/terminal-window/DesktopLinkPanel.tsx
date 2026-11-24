// "Let a computer use this device" in the Terminal window (spec 2716): which of
// the person's Matrix computers may open terminals and run agents here, with
// a confirmation that says plainly what that allows, and an instant off.
import { useState } from "react";
import { Laptop } from "lucide-react";
import type { MatrixComputer } from "@matrix-os/contracts";
import { Button, Dialog, DialogFooter, DialogTitle } from "@matrix-os/ui";
import type { DesktopLinkStateName, DesktopLinkStatusEntry } from "../../../../shared/desktop-link";
import { DESKTOP_LINK_ENABLE_FAILURE, type DesktopLinkView } from "./use-desktop-link";

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };

const STATE_TEXT: Record<DesktopLinkStateName, (name: string) => string> = {
  on: (name) => `${name} can use this device`,
  connecting: (name) => `Connecting to ${name}…`,
  offline: (name) => `${name} is out of reach. Retrying.`,
  removed: (name) => `${name} removed this device`,
  error: (name) => `Couldn't link to ${name}. Turn it on again.`,
  off: (name) => `${name} can't use this device`,
};

function statusLine(entry: DesktopLinkStatusEntry): string {
  const base = STATE_TEXT[entry.state](entry.computerName);
  if (entry.state !== "on" || entry.terminalsFromComputer === 0) return base;
  const count = entry.terminalsFromComputer;
  return `${base} · ${count} ${count === 1 ? "terminal" : "terminals"} open from it`;
}

/** Shown in the Terminal window's sidebar: the computers that may use this device, and how to add one. */
export function DesktopLinkPanel({ link, computers }: { link: DesktopLinkView; computers: readonly MatrixComputer[] }) {
  const [choosing, setChoosing] = useState(false);
  const active = link.computers.filter((entry) => entry.state !== "off");
  return (
    <section aria-label="Computers using this device" className="mt-2 border-t px-2 pt-2 text-[12px]" style={{ borderColor: "var(--border-subtle)" }}>
      {active.map((entry) => (
        <div key={entry.slot} data-desktop-link={entry.slot} data-state={entry.state} className="flex items-center gap-2 py-1">
          <Laptop size={12} aria-hidden="true" style={secondaryText} />
          <span role="status" className="min-w-0 flex-1 truncate">{statusLine(entry)}</span>
          {entry.state === "removed" || entry.state === "error" ? null : (
            <Button type="button" variant="ghost" size="sm" disabled={link.busySlot === entry.slot}
              aria-label={`Stop ${entry.computerName} using this device`} onClick={() => void link.disable(entry.slot)}>
              Turn off
            </Button>
          )}
        </div>
      ))}
      {computers.length > 0 ? (
        <button type="button" onClick={() => { link.clearFailure(); setChoosing(true); }}
          className="no-drag w-full rounded px-1 py-1 text-left outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-current"
          style={secondaryText}>
          Let a computer use this device…
        </button>
      ) : null}
      <DesktopLinkDialog open={choosing} link={link} computers={computers} onClose={() => setChoosing(false)} />
    </section>
  );
}

function DesktopLinkDialog({ open, link, computers, onClose }: {
  open: boolean; link: DesktopLinkView; computers: readonly MatrixComputer[]; onClose(): void;
}) {
  const [confirming, setConfirming] = useState<MatrixComputer | null>(null);
  const close = () => { setConfirming(null); onClose(); };
  const stateOf = (slot: string) => link.computers.find((entry) => entry.slot === slot)?.state ?? "off";
  return (
    <Dialog open={open} onClose={close} aria-label="Let a computer use this device" style={{ maxWidth: 460 }}>
      {confirming ? (
        <div className="flex flex-col gap-3">
          <DialogTitle>Let {confirming.label} use this device?</DialogTitle>
          <p className="m-0 text-[13px]">
            {confirming.label} will be able to open terminals and run agents on this device as you. That is full
            shell access: anything you can do in Terminal, it can do.
          </p>
          <p className="m-0 text-[12px]" style={secondaryText}>
            Only you, signed in to {confirming.label}, can use it. Nothing on this device listens for connections; this app
            connects out. Turn it off here or with Stop Computers Using This Device in the app menu at any time.
          </p>
          {link.failure ? <p role="alert" className="m-0 text-[12px]">{DESKTOP_LINK_ENABLE_FAILURE[link.failure]}</p> : null}
          <DialogFooter>
            <Button type="button" variant="secondary" size="sm" onClick={() => setConfirming(null)}>Back</Button>
            <Button type="button" size="sm" disabled={link.busySlot === confirming.runtimeSlot}
              onClick={() => {
                void link.enable(confirming.runtimeSlot, confirming.label).then((ok) => { if (ok) close(); });
              }}>
              {link.busySlot === confirming.runtimeSlot ? "Linking…" : `Let ${confirming.label} use this device`}
            </Button>
          </DialogFooter>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <DialogTitle>Let a computer use this device</DialogTitle>
          <p className="m-0 text-[12px]" style={secondaryText}>
            Choose one of your Matrix computers. It can then start terminals and agents here, under your macOS account.
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {computers.map((computer) => {
              const state = stateOf(computer.runtimeSlot);
              const on = state === "on" || state === "connecting" || state === "offline";
              return (
                <li key={computer.runtimeSlot} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px]">{computer.label}</span>
                  {on ? (
                    <Button type="button" variant="ghost" size="sm" disabled={link.busySlot === computer.runtimeSlot}
                      onClick={() => void link.disable(computer.runtimeSlot)}>Turn off</Button>
                  ) : (
                    <Button type="button" variant="secondary" size="sm" onClick={() => { link.clearFailure(); setConfirming(computer); }}>
                      Turn on…
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          <DialogFooter>
            <Button type="button" variant="secondary" size="sm" onClick={close}>Done</Button>
          </DialogFooter>
        </div>
      )}
    </Dialog>
  );
}
