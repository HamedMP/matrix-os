// Add machine… in the Terminal window (spec 2706 layer 7): a machine this
// device reaches over ssh, added to the local core as Herdr adds one. Keys
// stay with ssh; a host key or password only the person can answer is
// answered in a real terminal running ssh. Advanced fields (port, identity
// file, jump host) and Tailscale peers become an ssh command only in the
// main process.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Dialog, Input } from "@matrix-os/ui";
import {
  LocalMachineNameSchema, SshOptionsSchema, SshTargetSchema, type LocalMachineAddFailure, type SshOptions, type TailscalePeer,
} from "../../../../shared/local-terminals";
import type { AddMachineOutcome, TailscalePeersState } from "./use-ssh-machines";

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };

export const ADD_MACHINE_FAILURE: Record<LocalMachineAddFailure, string> = {
  unreachable: "Couldn't reach it over ssh. If ssh doesn't know this host's key yet, or asks for a password, open it in a terminal to check, then add it again.",
  hc_missing: "hc isn't installed on that machine. Install it there, then add it again.",
  incompatible: "That machine runs a version of hc this app can't use.",
  name_taken: "Another machine already has that name.",
  already_added: "That machine is already added.",
  invalid: "Check the address (host, user@host or user@host:port) and the advanced fields.",
  unavailable: "Couldn't add it. Try again.",
  needs_login: "This machine needs a password or one-time code. Complete the sign-in prompt in a terminal. If the machine doesn’t appear, try Add again.",
};

const TAILSCALE_NOTE: Record<Exclude<TailscalePeersState["status"], "ready" | "loading">, string> = {
  missing: "Tailscale isn't installed on this Mac.",
  stopped: "Tailscale isn't running on this Mac.",
  "logged-out": "Tailscale is logged out on this Mac.",
  unavailable: "Couldn't read your Tailscale machines.",
};

export interface AddMachineDialogProps {
  open: boolean;
  onAdd(target: string, name?: string, ssh?: SshOptions): Promise<AddMachineOutcome>;
  /** Opens a terminal running ssh to the target, with the same options. */
  onOpenSsh(target: string, ssh?: SshOptions, name?: string): Promise<boolean>;
  /** This Mac's tailnet peers. */
  loadPeers(): Promise<TailscalePeersState>;
  onClose(): void;
}

export function AddMachineDialog(props: AddMachineDialogProps) {
  return (
    <Dialog open={props.open} onClose={props.onClose} aria-label="Add machine" style={{ maxWidth: 480 }}>
      {props.open ? <AddMachineForm {...props} /> : null}
    </Dialog>
  );
}

/** A machine name from a peer's host name, within herdr-core's rules. */
function peerMachineName(peer: TailscalePeer): string | undefined {
  const name = peer.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 32);
  return LocalMachineNameSchema.safeParse(name).success ? name : undefined;
}

function TailscalePeers({ state, busy, onAdd }: { state: TailscalePeersState; busy: boolean; onAdd(peer: TailscalePeer): void }) {
  if (state.status === "loading") return <p role="status" className="text-[12px]" style={secondaryText}>Looking for your Tailscale machines…</p>;
  if (state.status !== "ready") return <p className="text-[12px]" style={secondaryText}>{TAILSCALE_NOTE[state.status]}</p>;
  if (state.peers.length === 0) return <p className="text-[12px]" style={secondaryText}>No other machines on your tailnet.</p>;
  return (
    <ul aria-label="Tailscale machines" className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
      {state.peers.map((peer) => (
        <li key={peer.dnsName} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[12px]">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ background: peer.online ? "var(--color-success)" : "var(--text-tertiary, #999)" }} />
          <span className="min-w-0 flex-1 truncate" title={peer.dnsName}>{peer.name}</span>
          <span className="shrink-0" style={secondaryText}>{peer.os}{peer.tailscaleSsh ? " · Tailscale SSH" : ""}</span>
          <Button type="button" variant="secondary" size="sm" disabled={busy} aria-label={`Add ${peer.name}`} onClick={() => onAdd(peer)}>Add</Button>
        </li>
      ))}
    </ul>
  );
}

function AddMachineForm({ onAdd, onOpenSsh, loadPeers, onClose }: AddMachineDialogProps) {
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [identity, setIdentity] = useState("");
  const [jump, setJump] = useState("");
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<LocalMachineAddFailure | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const [peers, setPeers] = useState<TailscalePeersState>({ status: "loading" });
  // The last attempt, so Open in terminal uses exactly what was tried.
  const [tried, setTried] = useState<{ target: string; ssh?: SshOptions } | null>(null);
  // A request still running when this form closes must not touch the next one.
  const alive = useRef(true);
  useEffect(() => {
    // Set again on setup: StrictMode runs cleanup and setup once more on mount.
    alive.current = true;
    void loadPeers().then((result) => { if (alive.current) setPeers(result); });
    return () => { alive.current = false; };
  }, [loadPeers]);

  const attempt = async (address: string, label: string | undefined, ssh: SshOptions | undefined) => {
    setAdding(true);
    setFailure(null);
    setTried({ target: address, ...(ssh ? { ssh } : {}) });
    const outcome = await onAdd(address, label, ssh);
    if (!alive.current) return;
    setAdding(false);
    if (outcome.ok) onClose();
    else setFailure(outcome.reason);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const address = target.trim();
    const label = name.trim().toLowerCase();
    const options = SshOptionsSchema.safeParse({
      ...(port.trim() ? { port: Number(port.trim()) } : {}),
      ...(identity.trim() ? { identity: identity.trim() } : {}),
      ...(jump.trim() ? { jump: jump.trim() } : {}),
    });
    if (!SshTargetSchema.safeParse(address).success || (label && !LocalMachineNameSchema.safeParse(label).success) || !options.success) {
      setFailure("invalid");
      return;
    }
    await attempt(address, label || undefined, Object.keys(options.data).length > 0 ? options.data : undefined);
  };

  const addPeer = (peer: TailscalePeer) => {
    void attempt(peer.dnsName, peerMachineName(peer), peer.tailscaleSsh ? { tailscaleSsh: true } : undefined);
  };

  const openSsh = async () => {
    if (!tried) return;
    setOpenFailed(false);
    const opened = await onOpenSsh(tried.target, tried.ssh, name.trim().toLowerCase() || undefined);
    if (!alive.current) return;
    if (opened) onClose();
    else setOpenFailed(true);
  };

  return (
    <form onSubmit={(event) => { void submit(event); }} className="flex flex-col gap-3">
      <h2 className="text-[15px] font-semibold">Add machine</h2>
      <p className="text-[13px]" style={secondaryText}>
        A machine you reach with ssh. Matrix OS uses your ssh setup: keys stay in ~/.ssh or your ssh agent and are never uploaded.
      </p>
      <section aria-label="Tailscale" className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-medium">On your tailnet</h3>
        <TailscalePeers state={peers} busy={adding} onAdd={addPeer} />
      </section>
      <Input label="ssh address" aria-label="ssh address" disabled={adding} placeholder="user@host or a Host from ~/.ssh/config" value={target} maxLength={255}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onChange={(event) => { setTarget(event.target.value); setFailure(null); }} />
      <Input label="Name (optional)" aria-label="Name" disabled={adding} placeholder="vps" value={name} maxLength={32}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onChange={(event) => { setName(event.target.value); setFailure(null); }} />
      <details className="text-[12px]">
        <summary className="cursor-pointer" style={secondaryText}>Advanced: port, identity file, jump host</summary>
        <div className="mt-2 flex flex-col gap-2">
          <Input label="Port" aria-label="Port" disabled={adding} inputMode="numeric" placeholder="22" value={port} maxLength={5}
            onChange={(event) => { setPort(event.target.value); setFailure(null); }} />
          <Input label="Identity file" aria-label="Identity file" disabled={adding} placeholder="~/.ssh/id_ed25519" value={identity} maxLength={1024}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={(event) => { setIdentity(event.target.value); setFailure(null); }} />
          <Input label="Jump host" aria-label="Jump host" disabled={adding} placeholder="user@bastion" value={jump} maxLength={255}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={(event) => { setJump(event.target.value); setFailure(null); }} />
        </div>
      </details>
      {failure ? <p role="alert" className="text-[12px]">{ADD_MACHINE_FAILURE[failure]}</p> : null}
      {openFailed ? <p role="alert" className="text-[12px]">Couldn't open a terminal. Try again.</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        {(failure === "unreachable" || failure === "needs_login") && tried ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => { void openSsh(); }}>Open in terminal</Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button type="submit" size="sm" disabled={adding || !target.trim()}>{adding ? "Adding…" : "Add"}</Button>
      </div>
    </form>
  );
}

/** Forgetting a machine keeps its terminals running there. The dialog stays until the core confirms. */
export function RemoveMachineDialog({ name, onConfirm, onClose }: {
  name: string | null; onConfirm(name: string): Promise<boolean>; onClose(): void;
}) {
  return (
    <Dialog open={name !== null} onClose={onClose} aria-label="Remove machine" style={{ maxWidth: 400 }}>
      {name ? <RemoveMachineBody key={name} name={name} onConfirm={onConfirm} onClose={onClose} /> : null}
    </Dialog>
  );
}

function RemoveMachineBody({ name, onConfirm, onClose }: { name: string; onConfirm(name: string): Promise<boolean>; onClose(): void }) {
  const [removing, setRemoving] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const remove = async () => {
    setRemoving(true);
    setFailed(false);
    const removed = await onConfirm(name);
    if (!alive.current) return;
    setRemoving(false);
    if (removed) onClose();
    else setFailed(true);
  };
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[15px] font-semibold">Remove “{name}”?</h2>
      <p className="text-[13px]" style={secondaryText}>This window forgets the machine. Its terminals keep running there.</p>
      {failed ? <p role="alert" className="text-[12px]">Couldn't remove it. Try again.</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button type="button" variant="destructive" size="sm" disabled={removing} onClick={() => { void remove(); }}>
          {removing ? "Removing…" : "Remove"}
        </Button>
      </div>
    </div>
  );
}
