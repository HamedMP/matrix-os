import { palette as c } from "@matrix-os/brand";

export function RepoStep({ title }: { title: string; status?: string; expanded?: boolean; onChange?: () => void }) {
  return <div style={{ border: `1px solid ${c.border}`, borderRadius: 11, background: c.card, padding: 12, fontSize: 14, color: c.deep }}>{title}</div>;
}
