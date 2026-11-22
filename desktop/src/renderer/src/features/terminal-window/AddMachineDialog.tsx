// Add machine… in the Terminal window (spec 2706 layer 7): a machine this
// device reaches over ssh, added to the local core as Herdr adds one. Keys
// stay with ssh; a host key or password only the person can answer is
// answered in a real terminal running `ssh <target>`.
import { useState, type FormEvent } from "react";
import { Button, Dialog, Input } from "@matrix-os/ui";
import {
  LocalMachineNameSchema, SshTargetSchema, type LocalMachineAddFailure,
} from "../../../../shared/local-terminals";
import type { AddMachineOutcome } from "./use-ssh-machines";

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };

export const ADD_MACHINE_FAILURE: Record<LocalMachineAddFailure, string> = {
  unreachable: "Couldn't reach it over ssh. If ssh doesn't know this host's key yet, or asks for a password, open it in a terminal to check, then add it again.",
  hc_missing: "hc isn't installed on that machine. Install it there, then add it again.",
  incompatible: "That machine runs a version of hc this app can't use.",
  name_taken: "Another machine already has that name.",
  already_added: "That machine is already added.",
  invalid: "Check the address: host, user@host or user@host:port.",
  unavailable: "Couldn't add it. Try again.",
};

export function AddMachineDialog({ open, onAdd, onOpenSsh, onClose }: {
  open: boolean;
  onAdd(target: string, name?: string): Promise<AddMachineOutcome>;
  /** Opens a terminal running `ssh <target>`. */
  onOpenSsh(target: string): Promise<boolean>;
  onClose(): void;
}) {
  return (
    <Dialog open={open} onClose={onClose} aria-label="Add machine" style={{ maxWidth: 440 }}>
      {open ? <AddMachineForm onAdd={onAdd} onOpenSsh={onOpenSsh} onClose={onClose} /> : null}
    </Dialog>
  );
}

function AddMachineForm({ onAdd, onOpenSsh, onClose }: {
  onAdd(target: string, name?: string): Promise<AddMachineOutcome>; onOpenSsh(target: string): Promise<boolean>; onClose(): void;
}) {
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<LocalMachineAddFailure | null>(null);
  const [openFailed, setOpenFailed] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = target.trim();
    const label = name.trim().toLowerCase();
    if (!SshTargetSchema.safeParse(trimmed).success || (label && !LocalMachineNameSchema.safeParse(label).success)) {
      setFailure("invalid");
      return;
    }
    setAdding(true);
    setFailure(null);
    const outcome = await onAdd(trimmed, label || undefined);
    setAdding(false);
    if (outcome.ok) onClose();
    else setFailure(outcome.reason);
  };

  const openSsh = async () => {
    setOpenFailed(false);
    if (await onOpenSsh(target.trim())) onClose();
    else setOpenFailed(true);
  };

  return (
    <form onSubmit={(event) => { void submit(event); }} className="flex flex-col gap-3">
      <h2 className="text-[15px] font-semibold">Add machine</h2>
      <p className="text-[13px]" style={secondaryText}>
        A machine you reach with ssh. Matrix OS uses your ssh setup: keys stay in ~/.ssh or your ssh agent and are never uploaded.
      </p>
      <Input label="ssh address" aria-label="ssh address" placeholder="user@host" value={target} maxLength={255}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onChange={(event) => { setTarget(event.target.value); setFailure(null); }} />
      <Input label="Name (optional)" aria-label="Name" placeholder="vps" value={name} maxLength={32}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onChange={(event) => { setName(event.target.value); setFailure(null); }} />
      {failure ? <p role="alert" className="text-[12px]">{ADD_MACHINE_FAILURE[failure]}</p> : null}
      {openFailed ? <p role="alert" className="text-[12px]">Couldn't open a terminal. Try again.</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        {failure === "unreachable" ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => { void openSsh(); }}>Open in terminal</Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button type="submit" size="sm" disabled={adding || !target.trim()}>{adding ? "Adding…" : "Add"}</Button>
      </div>
    </form>
  );
}

/** Forgetting a machine keeps its terminals running there. */
export function RemoveMachineDialog({ name, onConfirm, onClose }: { name: string | null; onConfirm(name: string): void; onClose(): void }) {
  return (
    <Dialog open={name !== null} onClose={onClose} aria-label="Remove machine" style={{ maxWidth: 400 }}>
      {name ? (
        <div className="flex flex-col gap-3">
          <h2 className="text-[15px] font-semibold">Remove “{name}”?</h2>
          <p className="text-[13px]" style={secondaryText}>This window forgets the machine. Its terminals keep running there.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="button" variant="destructive" size="sm" onClick={() => { onConfirm(name); onClose(); }}>Remove</Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
