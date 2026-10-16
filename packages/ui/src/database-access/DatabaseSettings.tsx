"use client";
import React, { useEffect, useRef, useState } from "react";
import { appGalleryPalette, desktopFonts, desktopPalette } from "@matrix-os/brand/tokens";
import { AlertCircle, ChevronRight, Database, Download, EyeOff, LockKeyhole, TerminalSquare } from "lucide-react";
import type { CSSProperties } from "react";
import "./database-access.css";
import * as Dialog from "@radix-ui/react-dialog";
import { DATABASE_ERROR, type DatabaseClient, type DatabaseCredential, type DatabaseSnapshot } from "./client";

export interface DatabaseSettingsProps {
  client: DatabaseClient;
  identityKey: string;
  onOpenTerminal?: (command: string, signal: AbortSignal) => Promise<void>;
  onDownload: (blob: Blob, signal: AbortSignal) => Promise<void>;
}
const brandStyle = {
  "--db-brand-paper": appGalleryPalette.paper,
  "--db-brand-fill": appGalleryPalette.surfaceMuted,
  "--db-brand-ink": appGalleryPalette.ink,
  "--db-brand-muted": appGalleryPalette.textMuted,
  "--db-brand-border": appGalleryPalette.border,
  "--db-brand-action": appGalleryPalette.action,
  "--db-brand-focus": desktopPalette.gold,
  "--db-font": `var(--font-geist-sans, ${desktopFonts.sans})`,
  "--db-mono": `var(--font-geist-mono, ${desktopFonts.mono})`,
} as CSSProperties;
function databaseConfirmationCopy(kind: "reset" | "export" | null, creating: boolean) {
  if (kind === "reset" && creating) return {
    title: "Create owner password?", action: "Create password",
    description: "Create a separate login to inspect, edit and export your data. Matrix’s own connection stays unchanged.",
  };
  if (kind === "reset") return {
    title: "Reset owner password?", action: "Confirm password reset",
    description: "New external connections must use the new password. Existing sessions may remain connected. Matrix’s own connection is unaffected.",
  };
  return {
    title: "Export your database?", action: "Download full export",
    description: "This export contains private messages and app data. Store it privately and share it only with people you trust. It excludes private owner-access metadata and files in your home directory. Restore it with pg_restore.",
  };
}
function DatabaseConnectionSummary({ snapshot, busy, terminalAvailable, onOpen }: {
  snapshot: DatabaseSnapshot;
  busy: boolean;
  terminalAvailable: boolean;
  onOpen: () => void;
}) {
  return (
    <section className="matrix-database-connection" aria-label="Connection details">
      <div className="matrix-database-connection-heading">
        <span className="matrix-database-glyph"><Database size={21} strokeWidth={1.5} aria-hidden="true" /></span>
        <div><h2>PostgreSQL</h2><p>On this Matrix computer</p></div>
        <span className="matrix-database-connection-label">Private connection</span>
      </div>
      <dl className="matrix-database-details">
        <div><dt>Host</dt><dd>{snapshot.connection.host}</dd></div>
        <div><dt>Port</dt><dd>{snapshot.connection.port}</dd></div>
        <div><dt>Database</dt><dd>{snapshot.connection.database}</dd></div>
        <div><dt>Username</dt><dd>{snapshot.connection.username}</dd></div>
      </dl>
      <div className="matrix-database-connect-action">
        <button className="matrix-database-button matrix-database-button-primary" disabled={busy || !snapshot.credentialReady || !terminalAvailable} onClick={onOpen}>
          <TerminalSquare size={16} aria-hidden="true" /> Open SQL Terminal
        </button>
        <p>{!snapshot.credentialReady ? "Create your owner password below to connect." : !terminalAvailable ? "Terminal access is unavailable in this session." : "Connect with your owner password."}</p>
      </div>
    </section>
  );
}
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
  const creatingPassword = snapshot?.credentialReady === false;
  const passwordAction = creatingPassword ? "Create password" : "Reset password";
  const confirmationCopy = databaseConfirmationCopy(confirmation, creatingPassword);
  return (
    <section className="matrix-database matrix-database-surface ph-no-capture ph-mask" style={brandStyle} data-private="true" aria-label="Database settings" data-database-settings="shared">
      <header className="matrix-database-header">
        <div>
          <h1>Database</h1>
          <p>Your data. Your PostgreSQL database.</p>
        </div>
        <span className="matrix-database-private"><LockKeyhole size={12} aria-hidden="true" /> Owner only</span>
      </header>
      {error && <div role="alert" className="matrix-database-feedback"><AlertCircle size={16} aria-hidden="true" /><span>{error}</span></div>}
      {!snapshot ? (
        <div role="status" className="matrix-database-loading">
          <Database size={22} strokeWidth={1.5} aria-hidden="true" />
          <p>{error ? "Database access could not be loaded." : "Loading database access…"}</p>
          {error && <button className="matrix-database-button matrix-database-button-secondary" onClick={() => { setError(null); setReload(value => value + 1); }}>Retry</button>}
        </div>
      ) : (
        <>
          <DatabaseConnectionSummary snapshot={snapshot} busy={busy} terminalAvailable={Boolean(onOpenTerminal)} onOpen={() => void run("terminal")} />

          <section className="matrix-database-section" aria-label="Owner credentials">
            <div className="matrix-database-row">
              <div className="matrix-database-row-copy"><h2>Access</h2><p>A separate owner login, managed by you.</p></div>
              <div className="matrix-database-row-actions">
                {snapshot.credentialReady && <button className="matrix-database-button matrix-database-button-secondary" disabled={busy} onClick={() => void run("reveal")}>Reveal password</button>}
                <button className={`matrix-database-button ${creatingPassword ? "matrix-database-button-secondary" : "matrix-database-button-ghost"}`} aria-disabled={busy} onClick={(event) => { if (busy) return; confirmationTrigger.current = event.currentTarget; hide(); setConfirmation("reset"); }}>{passwordAction}</button>
              </div>
            </div>
            {credential && (
              <div className="matrix-database-secret">
                <div className="matrix-database-secret-label"><label htmlFor="database-owner-password">Owner password</label><span>Hidden within 60 seconds</span></div>
                <div className="matrix-database-secret-field">
                  <input id="database-owner-password" readOnly value={credential.password} autoComplete="off" spellCheck={false} data-private="true" data-ph-no-capture="true" data-rrweb-mask="true" />
                  <button className="matrix-database-button matrix-database-button-ghost" onClick={hide}><EyeOff size={16} aria-hidden="true" /> Hide password</button>
                </div>
              </div>
            )}
          </section>

          <section className="matrix-database-section" aria-label="Full database export">
            <div className="matrix-database-row">
              <div className="matrix-database-row-copy"><h2>Backup</h2><p>All runtime user data in a portable PostgreSQL .dump.</p></div>
              <button className="matrix-database-button matrix-database-button-secondary" aria-disabled={busy} onClick={(event) => { if (busy) return; confirmationTrigger.current = event.currentTarget; hide(); setConfirmation("export"); }}><Download size={16} aria-hidden="true" /> Export database</button>
            </div>
          </section>

          <details className="matrix-database-ssh">
            <summary><div><h2>Connect from another computer</h2><p>Use your preferred database client over SSH.</p></div><ChevronRight size={17} aria-hidden="true" /></summary>
            <div className="matrix-database-ssh-content">
              <p>You need an owner-authorized SSH account on your server. This panel does not create one.</p>
              <ol>
                <li><p>Open a tunnel from your computer. Replace the placeholders with your SSH account and server.</p><pre>ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:15432:127.0.0.1:{snapshot.connection.port} &lt;ssh-user&gt;@&lt;your-server&gt;</pre></li>
                <li><p>Keep the tunnel open. Connect your database client to <code>127.0.0.1:15432</code>, using the database and username above and your owner password.</p></li>
              </ol>
              <p className="matrix-database-ssh-note"><LockKeyhole size={13} aria-hidden="true" /> PostgreSQL stays private. No public database port is needed.</p>
            </div>
          </details>
        </>
      )}
      <Dialog.Root open={confirmation !== null} onOpenChange={(open) => { if (!open) setConfirmation(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="matrix-database-overlay" style={brandStyle} />
          <Dialog.Content role="alertdialog" className="matrix-database-dialog matrix-database-surface" style={brandStyle} onOpenAutoFocus={(event) => { event.preventDefault(); cancelButton.current?.focus(); }} onCloseAutoFocus={(event) => { event.preventDefault(); confirmationTrigger.current?.focus(); }}>
            <Dialog.Title>{confirmationCopy.title}</Dialog.Title>
            <Dialog.Description>{confirmationCopy.description}</Dialog.Description>
            <div className="matrix-database-dialog-actions">
              <button ref={cancelButton} className="matrix-database-button matrix-database-button-secondary" onClick={() => setConfirmation(null)}>Cancel</button>
              <button className="matrix-database-button matrix-database-button-primary" disabled={busy} onClick={() => { if (confirmation) void run(confirmation); }}>{confirmationCopy.action}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {busy && <p role="status" className="matrix-database-working">Working…</p>}
    </section>
  );
}
