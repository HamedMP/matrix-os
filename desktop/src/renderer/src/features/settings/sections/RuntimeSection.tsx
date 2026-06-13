import { useEffect, useState } from "react";
import { Button } from "../../../design/primitives";
import { useConnection } from "../../../stores/connection";
import { Card, Row, SectionHeader } from "./section-kit";

export default function RuntimeSection() {
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const selectRuntime = useConnection((s) => s.selectRuntime);
  const [slot, setSlot] = useState(runtimeSlot);

  useEffect(() => {
    setSlot(runtimeSlot);
  }, [runtimeSlot]);

  return (
    <>
      <SectionHeader title="Runtime" description="Choose which of your computers this app targets." />
      <Card>
        <Row label="Active runtime" value={runtimeSlot} />
        <div className="flex items-center gap-2 border-t pt-3" style={{ borderColor: "var(--border-subtle)" }}>
          <input
            value={slot}
            onChange={(e) => setSlot(e.target.value)}
            maxLength={64}
            placeholder="primary"
            className="h-8 flex-1 rounded-md border bg-transparent px-2.5 text-sm outline-none"
            style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
          />
          <Button
            variant="primary"
            disabled={slot.trim().length === 0 || slot === runtimeSlot}
            onClick={() => {
              void selectRuntime(slot.trim()).catch((err: unknown) => {
                console.warn(
                  "[settings] runtime switch failed:",
                  err instanceof Error ? err.message : String(err),
                );
              });
            }}
          >
            Switch
          </Button>
        </div>
      </Card>
    </>
  );
}
