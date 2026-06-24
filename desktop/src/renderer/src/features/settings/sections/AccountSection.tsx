import { Button } from "../../../design/primitives";
import { invoke } from "../../../lib/operator";
import { useConnection } from "../../../stores/connection";
import { Card, Row, SectionHeader } from "./section-kit";

function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "M";
}

export default function AccountSection() {
  const handle = useConnection((s) => s.handle);
  const displayName = useConnection((s) => s.displayName);
  const imageUrl = useConnection((s) => s.imageUrl);
  const platformHost = useConnection((s) => s.platformHost);
  const signOut = useConnection((s) => s.signOut);
  const manageUrl = platformHost.startsWith("https://") ? platformHost : "https://app.matrix-os.com";
  const accountName = displayName ?? (handle ? `@${handle}` : "Account");

  return (
    <>
      <SectionHeader title="Account" description="Your Matrix OS identity and session." />
      <Card>
        <div className="flex items-center gap-3">
          <div
            className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-semibold"
            style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
          >
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={`${accountName} avatar`}
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              initialsFor(accountName)
            )}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              {accountName}
            </p>
            <p className="truncate text-xs" style={{ color: "var(--text-tertiary)" }}>
              {handle ? `@${handle}` : "Not signed in"}
            </p>
          </div>
        </div>
        <Row label="Handle" value={handle ? `@${handle}` : "–"} />
        <Row label="Platform" value={platformHost} />
        <div className="flex items-center justify-between border-t pt-3" style={{ borderColor: "var(--border-subtle)" }}>
          <Button variant="subtle" onClick={() => void invoke("shell:open-external", { url: manageUrl })}>
            Manage account
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              void signOut().catch((err: unknown) => {
                console.warn(
                  "[settings] sign-out failed:",
                  err instanceof Error ? err.message : String(err),
                );
              });
            }}
          >
            Sign out
          </Button>
        </div>
      </Card>
    </>
  );
}
