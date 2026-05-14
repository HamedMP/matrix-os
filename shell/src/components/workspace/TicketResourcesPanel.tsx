"use client";

export interface TicketResourceTicket {
  id?: string;
  identifier?: string;
  title?: string;
}

export interface TicketArtifact {
  id: string;
  label: string;
  kind: string;
}

export interface TicketPreview {
  id?: string;
  label?: string;
  url?: string;
  lastStatus?: string;
}

export function TicketResourcesPanel({
  ticket,
  artifacts,
  previews,
}: {
  ticket: TicketResourceTicket | null;
  artifacts: TicketArtifact[];
  previews: TicketPreview[];
}) {
  return (
    <section className="border-b border-border px-4 py-3">
      <h2 className="text-sm font-semibold">Ticket resources</h2>
      <p className="mt-1 text-xs text-muted-foreground">{ticket?.identifier ?? "No ticket selected"}</p>
      <div className="mt-3 space-y-2">
        {artifacts.map((artifact) => (
          <div key={artifact.id} className="rounded-md border border-border px-2 py-1 text-xs">
            <span className="font-medium">{artifact.label}</span>
            <span className="ml-2 text-muted-foreground">{artifact.kind}</span>
          </div>
        ))}
        {previews.map((preview) => (
          <a key={preview.id ?? preview.url} href={preview.url} target="_blank" rel="noreferrer" className="block rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
            <span className="font-medium">{preview.label ?? preview.url}</span>
            <span className="ml-2 text-muted-foreground">{preview.lastStatus ?? "unknown"}</span>
          </a>
        ))}
      </div>
    </section>
  );
}
