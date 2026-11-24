// The desktop link in the Terminal window (spec 2716): whether the computer this
// device is paired with (2698) can use it now, with an instant Turn off and a
// way to turn it back on. Pairing itself is 2698's native dialog, which says
// plainly what pairing allows and is where the person confirms it.
import { Laptop } from "lucide-react";
import { Button } from "@matrix-os/ui";
import type { DesktopLinkStateName, DesktopLinkStatusEntry } from "../../../../shared/desktop-link";
import { DESKTOP_LINK_ENABLE_FAILURE, type DesktopLinkView } from "./use-desktop-link";

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };

const STATE_TEXT: Record<DesktopLinkStateName, (name: string) => string> = {
  on: (name) => `${name} can use this device`,
  connecting: (name) => `Connecting to ${name}…`,
  offline: (name) => `${name} is out of reach. Retrying.`,
  removed: (name) => `${name} is no longer paired with this device`,
  error: (name) => `Couldn't link to ${name}. Pair this device again.`,
  off: (name) => `${name} can't use this device until you turn it on`,
};

function statusLine(entry: DesktopLinkStatusEntry): string {
  const base = STATE_TEXT[entry.state](entry.computerName);
  if (entry.state !== "on" || entry.terminalsFromComputer === 0) return base;
  const count = entry.terminalsFromComputer;
  return `${base} · ${count} ${count === 1 ? "terminal" : "terminals"} open from it`;
}

/** Shown in the Terminal window's sidebar: the paired computer's link, and how to pair. */
export function DesktopLinkPanel({ link }: { link: DesktopLinkView }) {
  const entry = link.computers.find((computer) => computer.slot === "primary");
  const paired = entry !== undefined && entry.state !== "removed" && entry.state !== "error";
  return (
    <section aria-label="Computers using this device" className="mt-2 border-t px-2 pt-2 text-[12px]" style={{ borderColor: "var(--border-subtle)" }}>
      {entry ? (
        <div data-desktop-link={entry.slot} data-state={entry.state} className="flex items-center gap-2 py-1">
          <Laptop size={12} aria-hidden="true" style={secondaryText} />
          <span role="status" className="min-w-0 flex-1 truncate">{statusLine(entry)}</span>
          {entry.state === "off" ? (
            <Button type="button" variant="ghost" size="sm" disabled={link.busySlot === entry.slot}
              aria-label={`Let ${entry.computerName} use this device`} onClick={() => void link.enable(entry.slot, entry.computerName)}>
              Turn on
            </Button>
          ) : paired ? (
            <Button type="button" variant="ghost" size="sm" disabled={link.busySlot === entry.slot}
              aria-label={`Stop ${entry.computerName} using this device`} onClick={() => void link.disable(entry.slot)}>
              Turn off
            </Button>
          ) : null}
        </div>
      ) : null}
      {link.failure ? <p role="alert" className="m-0 py-1 text-[12px]">{DESKTOP_LINK_ENABLE_FAILURE[link.failure]}</p> : null}
      {paired ? null : (
        <button type="button" disabled={link.pairing} onClick={() => void link.pair()}
          className="no-drag w-full rounded px-1 py-1 text-left outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50"
          style={secondaryText}>
          Pair this device with your computer…
        </button>
      )}
    </section>
  );
}
