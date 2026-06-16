import { Button } from "../../../design/primitives";
import { invoke } from "../../../lib/operator";
import { useConnection } from "../../../stores/connection";
import { Card, Row, SectionHeader } from "./section-kit";

export default function AccountSection() {
  const handle = useConnection((s) => s.handle);
  const platformHost = useConnection((s) => s.platformHost);
  const signOut = useConnection((s) => s.signOut);
  const manageUrl = platformHost.startsWith("https://") ? platformHost : "https://app.matrix-os.com";

  return (
    <>
      <SectionHeader title="Account" description="Your Matrix OS identity and session." />
      <Card>
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
