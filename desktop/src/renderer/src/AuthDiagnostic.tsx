import React from "react";
import type { InvokeResponse } from "../../shared/ipc-contract";

export interface AuthDiagnosticSnapshot {
  auth: InvokeResponse<"auth:status"> | null;
  version: InvokeResponse<"app:get-version"> | null;
}

export function AuthDiagnostic({ auth, version }: AuthDiagnosticSnapshot) {
  return <main data-selectable className="h-screen overflow-auto bg-[var(--bg-app)] p-8 text-[var(--text-primary)]">
    <h1 className="mb-4 text-xl font-semibold">Native auth diagnostic</h1>
    <p className="mb-6">Local auth and app provenance only. Chat and Bot acceptance has not run.</p>
    <dl className="space-y-2">
      <dt>Local session</dt>
      <dd>{auth ? (auth.signedIn ? "Signed in" : "Signed out")
        : <span role="alert">Local auth status could not be read.</span>}</dd>
      {auth?.signedIn && <><dt>Account</dt><dd>{auth.handle}</dd><dt>Computer slot</dt><dd>{auth.runtimeSlot}</dd></>}
      {auth && !auth.signedIn && <dd>No valid local session is available.</dd>}
      <dt>App version</dt>
      <dd>{version?.version ?? <span role="alert">App version could not be read.</span>}</dd>
      <dt>Source commit</dt><dd className="break-all">{version?.source?.commit ?? "Source unavailable"}</dd>
    </dl>
  </main>;
}
