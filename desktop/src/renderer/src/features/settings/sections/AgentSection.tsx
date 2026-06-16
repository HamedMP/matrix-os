import { Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../design/primitives";
import { toUserMessage } from "../../../lib/errors";
import { useConnection } from "../../../stores/connection";
import { Card, Empty, SectionHeader } from "./section-kit";

const SOUL_PATH = "/files/system/soul.md";

export default function AgentSection() {
  const api = useConnection((s) => s.api);
  const [soul, setSoul] = useState("");
  const [baseline, setBaseline] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const saveSeqRef = useRef(0);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .getText(SOUL_PATH)
      .then((text) => {
        if (cancelled) return;
        setSoul(text);
        setBaseline(text);
        setLoaded(true);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoaded(true);
          setError(toUserMessage(err));
        }
      });
    return () => { cancelled = true; };
  }, [api]);

  const dirty = soul !== baseline;

  const save = async () => {
    if (!api || !dirty) return;
    const saveSeq = saveSeqRef.current + 1;
    saveSeqRef.current = saveSeq;
    const nextSoul = soul;
    if (savedTimerRef.current) {
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    setStatus("saving");
    try {
      await api.putText(SOUL_PATH, nextSoul);
      if (!mountedRef.current || saveSeqRef.current !== saveSeq) return;
      setBaseline(nextSoul);
      setError(null);
      setStatus("saved");
      savedTimerRef.current = setTimeout(() => {
        savedTimerRef.current = null;
        if (mountedRef.current && saveSeqRef.current === saveSeq) setStatus("idle");
      }, 1500);
    } catch (err: unknown) {
      if (!mountedRef.current || saveSeqRef.current !== saveSeq) return;
      setError(toUserMessage(err));
      setStatus("error");
    }
  };

  return (
    <>
      <SectionHeader
        title="Agent (Hermes)"
        description="Hermes is your OS agent. Its identity and standing instructions live in SOUL — edit it here and every conversation picks it up."
      />
      <Card>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>SOUL · system/soul.md</span>
          <div className="flex items-center gap-2">
            {status === "saved" ? <span className="text-xs" style={{ color: "var(--success)" }}>Saved</span> : null}
            <Button variant="primary" disabled={!dirty || status === "saving"} onClick={() => void save()}>
              <Save size={13} />
              {status === "saving" ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
        {!loaded ? (
          <Empty text="Loading…" />
        ) : (
          <textarea
            value={soul}
            onChange={(e) => setSoul(e.target.value)}
            spellCheck={false}
            className="min-h-[320px] w-full resize-y rounded-lg border bg-transparent p-3 font-mono text-xs leading-relaxed outline-none"
            style={{ borderColor: "var(--border-default)", color: "var(--text-primary)", background: "var(--bg-sunken)" }}
            placeholder="# SOUL&#10;&#10;You are Hermes, the Matrix OS agent…"
            data-selectable
          />
        )}
        {error ? <span className="text-xs" style={{ color: "var(--danger)" }}>{error}</span> : null}
      </Card>
      <Card>
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Model & persona</span>
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          Model routing, persona, and tool access are governed by your kernel configuration on the VPS.
          Deeper in-app controls (model picker, reasoning effort, per-tool permissions) arrive with the
          agent-config gateway endpoints.
        </p>
      </Card>
    </>
  );
}
