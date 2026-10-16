"use client";
import React, { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { DATABASE_ERROR, type DatabaseClient, type DatabaseCredential, type DatabaseSnapshot } from "./client";

export interface DatabaseSettingsProps {
  client: DatabaseClient;
  identityKey: string;
  onOpenTerminal?: (command: string, signal: AbortSignal) => Promise<void>;
  onDownload: (blob: Blob, signal: AbortSignal) => Promise<void>;
}
const button = "rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:cursor-not-allowed";
const card = "space-y-3 rounded-lg border border-border p-4";
/** Keying the inner view removes secrets before the new identity's first paint. */
export function DatabaseSettings(props: DatabaseSettingsProps) { return <DatabaseSettingsView key={props.identityKey} {...props} />; }
function DatabaseSettingsView({ client, onOpenTerminal, onDownload }: DatabaseSettingsProps) {
  const [snapshot, setSnapshot] = useState<DatabaseSnapshot | null>(null);
  const [credential, setCredential] = useState<DatabaseCredential | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<"reset" | "export" | null>(null);
  const [reload, setReload] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  const sensitiveEpoch = useRef(0);
  const inFlight = useRef(false);
  const confirmationTrigger = useRef<HTMLButtonElement | null>(null);
  const cancelButton = useRef<HTMLButtonElement | null>(null);
  const hide = () => { sensitiveEpoch.current += 1; setCredential(null); };
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void client.get(controller.signal).then(value => { if (!controller.signal.aborted) setSnapshot(value); }).catch(() => { if (!controller.signal.aborted) setError(DATABASE_ERROR); });
    const hidePassword = () => { sensitiveEpoch.current += 1; setCredential(null); };
    window.addEventListener("blur", hidePassword);
    document.addEventListener("visibilitychange", hidePassword);
    return () => { controller.abort(); sensitiveEpoch.current += 1; window.removeEventListener("blur", hidePassword); document.removeEventListener("visibilitychange", hidePassword); };
  }, [client, reload]);
  useEffect(() => { if (!credential) return; const timer = setTimeout(hide, 60_000); return () => clearTimeout(timer); }, [credential]);
  async function run(kind: "reveal" | "reset" | "terminal" | "export") {
    const scope = lifetime.current;
    if (!scope || scope.signal.aborted || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null); setConfirmation(null); hide();
    const epoch = sensitiveEpoch.current;
    try {
      if (kind === "reveal" || kind === "reset") {
        const value = await client[kind](scope.signal);
        if (!scope.signal.aborted) {
          if (value.username !== snapshot?.connection.username) throw new Error(DATABASE_ERROR);
          setSnapshot(current => current ? { ...current, credentialReady: true } : current);
          if (sensitiveEpoch.current === epoch && document.visibilityState !== "hidden") setCredential(value);
        }
      } else if (kind === "terminal") {
        const command = await client.terminal(scope.signal);
        if (!scope.signal.aborted && onOpenTerminal) await onOpenTerminal(command, scope.signal);
      } else {
        const blob = await client.export(scope.signal);
        if (!scope.signal.aborted) await onDownload(blob, scope.signal);
      }
    } catch { if (!scope.signal.aborted) setError(DATABASE_ERROR); }
    finally {
      inFlight.current = false;
      if (!scope.signal.aborted) {
        // The view may have unmounted; keep the lifetime guard when clearing this flag.
        // eslint-disable-next-line react-doctor/no-loading-flag-reset-outside-finally -- this is inside finally, with a stale-view guard
        setBusy(false);
      }
    }
  }
  return <section className="ph-no-capture ph-mask mx-auto max-w-3xl space-y-5 p-5 text-foreground" data-private="true" aria-label="Database settings" data-database-settings="shared">
    <header><h1 className="text-xl font-semibold">Database</h1><p className="mt-1 text-sm text-muted-foreground">Inspect and export the PostgreSQL database on this Matrix computer. Database access is available only to its owner.</p></header>
    {error && <p role="alert" className="text-sm">{error}</p>}
    {!snapshot ? <div role="status" className={card}><p>{error ? "Database access could not be loaded." : "Loading database access…"}</p>{error && <button className={button} onClick={() => { setError(null); setReload(value => value + 1); }}>Retry</button>}</div> : <>
      <section className={card} aria-label="Connection details"><h2 className="font-semibold">Connection details</h2><p className="text-sm text-muted-foreground">These details connect from this computer. Remote clients use an SSH tunnel.</p><dl className="grid grid-cols-2 gap-2 text-sm">{Object.entries(snapshot.connection).map(([label, value]) => <div key={label}><dt className="capitalize text-muted-foreground">{label}</dt><dd className="break-all font-mono">{value}</dd></div>)}</dl></section>
      <section className={card} aria-label="Owner credentials"><h2 className="font-semibold">Owner credentials</h2><p className="text-sm text-muted-foreground">This separate owner login accesses your runtime data. After a reset, new connections need the new password. Existing database sessions may remain connected. Matrix keeps running.</p>{!snapshot.credentialReady && <p role="status" className="text-sm">Create your owner password with Reset password to enable database access.</p>}
        {credential && <div className="space-y-2"><label className="block text-sm" htmlFor="database-owner-password">Owner password (hidden within 60 seconds)</label><input id="database-owner-password" className="w-full rounded border border-border bg-background px-3 py-2 font-mono text-sm" readOnly value={credential.password} autoComplete="off" spellCheck={false} data-private="true" data-ph-no-capture="true" data-rrweb-mask="true" /><button className={button} onClick={hide}>Hide password</button></div>}
        <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !snapshot.credentialReady} onClick={() => void run("reveal")}>Reveal password</button><button className={button} aria-disabled={busy} onClick={(event) => { if (busy) return; confirmationTrigger.current = event.currentTarget; hide(); setConfirmation("reset"); }}>Reset password</button></div>
      </section>
      <section className={card}><h2 className="font-semibold">SQL Terminal</h2><p className="text-sm text-muted-foreground">Open psql on this computer, then enter your owner password at its password prompt. SQL can change or delete your data.</p><button className={button} disabled={busy || !snapshot.credentialReady || !onOpenTerminal} onClick={() => void run("terminal")}>Open SQL Terminal</button>{!onOpenTerminal && <p className="text-sm text-muted-foreground">Terminal access is unavailable in this session.</p>}</section>
      <section className={card}><h2 className="font-semibold">Full database export</h2><p className="text-sm text-muted-foreground">Download a PostgreSQL custom-format .dump containing all runtime user data, excluding private owner-access metadata. Restore with pg_restore. Files in your home directory need a separate backup.</p><button className={button} aria-disabled={busy} onClick={(event) => { if (busy) return; confirmationTrigger.current = event.currentTarget; hide(); setConfirmation("export"); }}>Export database</button></section>
      <section className={card}><h2 className="font-semibold">Connect through SSH</h2><p className="text-sm text-muted-foreground">You need an owner-authorized SSH account on your server. This panel does not create one. Replace the placeholders before running this command on your own computer.</p><pre className="overflow-x-auto rounded bg-muted p-3 text-xs">ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:15432:127.0.0.1:{snapshot.connection.port} &lt;ssh-user&gt;@&lt;your-server&gt;</pre><p className="text-sm text-muted-foreground">In your database client, connect to 127.0.0.1:15432 using the database and owner username above and your owner password. Keep PostgreSQL private; no public database port is needed.</p></section>
    </>}
    <Dialog.Root open={confirmation !== null} onOpenChange={(open) => { if (!open) setConfirmation(null); }}><Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[100] bg-background/80 backdrop-blur-sm" />
      <Dialog.Content role="alertdialog" className="fixed left-1/2 top-1/2 z-[101] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-lg border border-border bg-background p-5 text-foreground shadow-lg" onOpenAutoFocus={(event) => { event.preventDefault(); cancelButton.current?.focus(); }} onCloseAutoFocus={(event) => { event.preventDefault(); confirmationTrigger.current?.focus(); }}>
        <Dialog.Title className="font-semibold">{confirmation === "reset" ? "Reset owner password?" : "Download all database data?"}</Dialog.Title>
        <Dialog.Description className="text-sm">{confirmation === "reset" ? "New external connections must use the new password. Existing sessions may remain connected. Matrix’s own connection is unaffected." : "This export includes sensitive runtime data, including private messages and app data. Store it privately and share it only with people you trust."}</Dialog.Description>
        <div className="flex gap-2"><button className={button} disabled={busy} onClick={() => { if (confirmation) void run(confirmation); }}>{confirmation === "reset" ? "Confirm password reset" : "Download full export"}</button><button ref={cancelButton} className={button} onClick={() => setConfirmation(null)}>Cancel</button></div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
    {busy && <p role="status" className="text-sm text-muted-foreground">Working…</p>}
  </section>;
}
