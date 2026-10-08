"use client";
import { useState } from "react";
import type { ConnectedService } from "./integrations-helpers";
import type { IntegrationCatalogItem } from "@matrix-os/contracts/integration-marketplace";

const CATEGORY_COLORS: Record<string, string> = {
  google: "bg-blue-500",
  developer: "bg-gray-700",
  communication: "bg-indigo-500",
};

function ServiceLogo({ name, category, logoUrl }: { name: string; category: string; logoUrl?: string }) {
  const [imgError, setImgError] = useState(false);
  const bg = CATEGORY_COLORS[category] ?? "bg-primary";

  if (logoUrl && !imgError) {
    return (
      // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- remote service logo from arbitrary unconfigured host; next/image would require host allowlisting
      <img
        src={logoUrl}
        alt={name}
        width={40}
        height={40}
        className="size-10 rounded-lg shrink-0 object-contain"
        onError={() => setImgError(true)}
      />
    );
  }

  return (
    <div className={`size-10 rounded-lg ${bg} flex items-center justify-center text-white font-semibold text-sm shrink-0`}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "active"
      ? "bg-green-500"
      : status === "expired"
        ? "bg-yellow-500"
        : "bg-red-500";
  return <span className={`inline-block size-2 rounded-full ${color}`} />;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch (_err: unknown) {
    return iso;
  }
}

function groupByService(connections: ConnectedService[]): Map<string, ConnectedService[]> {
  const groups = new Map<string, ConnectedService[]>();
  for (const conn of connections) {
    const existing = groups.get(conn.service);
    if (existing) {
      existing.push(conn);
    } else {
      groups.set(conn.service, [conn]);
    }
  }
  return groups;
}


export function ConnectedIntegrationAccounts({ connected, available, renamingId, renameDraft, savingRename, checkingStatus, confirmDisconnect, disconnecting, setRenameDraft, setRenamingId, setConfirmDisconnect, handleRename, handleCheckStatus, handleDisconnect }: {
 connected: ConnectedService[]; available: IntegrationCatalogItem[]; renamingId: string | null; renameDraft: string; savingRename: string | null; checkingStatus: string | null; confirmDisconnect: string | null; disconnecting: string | null;
 setRenameDraft: (value: string) => void; setRenamingId: (value: string | null) => void; setConfirmDisconnect: (value: string | null) => void;
 handleRename: (id: string) => Promise<void>; handleCheckStatus: (id: string) => Promise<void>; handleDisconnect: (id: string) => Promise<void>;
}) { return <>
      {/* Connected Services -- grouped by service */}
      {connected.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Connected
          </h3>
          <div className="space-y-4">
            {Array.from(groupByService(connected)).map(([serviceId, accounts]) => {
              const def = available.find((s) => s.id === serviceId);
              const serviceName = def?.name ?? serviceId;
              const category = def?.category ?? "developer";
              const hasMultiple = accounts.length > 1;
              return (
                <div key={serviceId} className="space-y-1">
                  {hasMultiple && (
                    <div className="flex items-center gap-2 mb-2">
                      <ServiceLogo name={serviceName} category={category} logoUrl={def?.logoUrl} />
                      <span className="text-sm font-medium">{serviceName}</span>
                      <span className="text-xs text-muted-foreground">
                        {accounts.length} accounts
                      </span>
                    </div>
                  )}
                  <div className={`space-y-2 ${hasMultiple ? "ml-12" : ""}`}>
                    {accounts.map((conn) => (
                      <div
                        key={conn.id}
                        className="flex items-center gap-4 rounded-lg border border-border/60 bg-card/50 px-4 py-3"
                      >
                        {!hasMultiple && (
                          <ServiceLogo name={serviceName} category={category} logoUrl={def?.logoUrl} />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            {renamingId === conn.id ? (
                              <input
                                type="text"
                                aria-label="Account label"
                                // react-doctor-disable-next-line react-doctor/no-autofocus -- inline rename field rendered only after user clicks rename; focus is essential to the edit affordance
                                autoFocus
                                value={renameDraft}
                                onChange={(e) => setRenameDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleRename(conn.id);
                                  if (e.key === "Escape") {
                                    setRenamingId(null);
                                    setRenameDraft("");
                                  }
                                }}
                                disabled={savingRename === conn.id}
                                placeholder="Label (e.g. Work, Personal)"
                                maxLength={100}
                                className="flex-1 min-w-0 rounded-md border border-border/60 bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
                              />
                            ) : (
                              <span className="text-sm font-medium truncate">
                                {hasMultiple ? conn.account_label : serviceName}
                              </span>
                            )}
                            <StatusDot status={conn.status} />
                            <span className="text-xs text-muted-foreground capitalize">
                              {conn.status}
                            </span>
                          </div>
                          {conn.account_email && (
                            <div className="text-sm text-muted-foreground truncate mt-0.5">
                              {conn.account_email}
                            </div>
                          )}
                          <div className="text-xs text-muted-foreground/60 mt-0.5">
                            {!hasMultiple && conn.account_label !== serviceName && conn.account_label}
                            {!hasMultiple && conn.account_label !== serviceName && " · "}
                            Connected {formatDate(conn.connected_at)}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {renamingId === conn.id ? (
                            <>
                              <button
                                type="button"
                                onClick={() => handleRename(conn.id)}
                                disabled={savingRename === conn.id || !renameDraft.trim()}
                                className="rounded-md bg-primary text-primary-foreground px-2.5 py-1.5 text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                              >
                                {savingRename === conn.id ? "Saving..." : "Save"}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setRenamingId(null);
                                  setRenameDraft("");
                                }}
                                disabled={savingRename === conn.id}
                                className="rounded-md border border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setRenamingId(conn.id);
                                setRenameDraft(conn.account_label);
                              }}
                              className="rounded-md border border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors"
                            >
                              Rename
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleCheckStatus(conn.id)}
                            disabled={checkingStatus === conn.id}
                            className="rounded-md border border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors disabled:opacity-50"
                          >
                            {checkingStatus === conn.id ? "Checking..." : "Check Status"}
                          </button>
                          {confirmDisconnect === conn.id ? (
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleDisconnect(conn.id)}
                                disabled={disconnecting === conn.id}
                                className="rounded-md bg-red-500/15 border border-red-500/40 px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-500/25 transition-colors disabled:opacity-50"
                              >
                                {disconnecting === conn.id ? "Removing..." : "Confirm"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDisconnect(null)}
                                className="rounded-md border border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDisconnect(conn.id)}
                              className="rounded-md border border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-red-400 hover:border-red-500/40 transition-colors"
                            >
                              Disconnect
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}


</>; }
