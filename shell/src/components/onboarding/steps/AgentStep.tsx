import { palette as c } from "@matrix-os/brand";

export function AgentStep({ title }: { title: string; status?: string; expanded?: boolean; onOpenTerminal?: (p: string) => void; onChange?: () => void }) {
  return <div style={{ border: `1px solid ${c.border}`, borderRadius: 11, background: c.card, padding: 12, fontSize: 14, color: c.deep }}>{title}</div>;
}
