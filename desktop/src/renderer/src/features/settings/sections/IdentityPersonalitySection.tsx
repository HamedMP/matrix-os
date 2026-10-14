import { OWNER_SOUL_MAX_BYTES, ownerSoulExceedsLimit, ownerSoulHasInvalidControls } from "@matrix-os/contracts/bots";
import { Save } from "@renderer/lib/hugeicons";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../design/primitives";
import { toUserMessage } from "../../../lib/errors";
import { useConnection } from "../../../stores/connection";
import { Card, Empty, SettingsSectionHeader } from "./section-kit";

const SOUL_PATH = "/files/system/soul.md";

function SoulEditor() {
  const api = useConnection((state) => state.api);
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
      .catch((cause: unknown) => {
        if (!cancelled) {
          setLoaded(true);
          setError(toUserMessage(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const dirty = soul !== baseline;
  const exceedsLimit = ownerSoulExceedsLimit(soul);
  const invalidControls = ownerSoulHasInvalidControls(soul);
  const validationError = exceedsLimit
    ? `Content exceeds the ${OWNER_SOUL_MAX_BYTES / 1024} KiB UTF-8 limit. Shorten it before saving.`
    : invalidControls ? "Remove unsupported control characters before saving." : null;
  const save = async () => {
    if (!api || !dirty || validationError) return;
    const saveSeq = saveSeqRef.current + 1;
    saveSeqRef.current = saveSeq;
    const nextSoul = soul;
    if (savedTimerRef.current) {
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    setStatus("saving");
    setError(null);
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
    } catch (cause: unknown) {
      if (!mountedRef.current || saveSeqRef.current !== saveSeq) return;
      setError(toUserMessage(cause));
      setStatus("error");
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>SOUL · system/soul.md</span>
        <div className="flex items-center gap-2">
          {status === "saved" ? <span className="text-xs" style={{ color: "var(--success)" }}>Saved</span> : null}
          <Button variant="primary" disabled={!dirty || status === "saving" || !!validationError} onClick={() => void save()}>
            <Save size={13} />
            {status === "saving" ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
        Up to {OWNER_SOUL_MAX_BYTES / 1024} KiB of UTF-8 text. Applies to your personal Matrix Bot.
      </p>
      {!loaded ? (
        <Empty text="Loading…" />
      ) : (
        <textarea
          value={soul}
          onChange={(event) => setSoul(event.target.value)}
          spellCheck={false}
          aria-label="SOUL system instructions"
          className="min-h-[260px] w-full resize-y rounded-lg border bg-transparent p-3 font-mono text-xs leading-relaxed outline-none"
          style={{ borderColor: "var(--border-default)", color: "var(--text-primary)", background: "var(--bg-sunken)" }}
          placeholder="# SOUL&#10;&#10;You are Hermes, the Matrix OS agent…"
          data-selectable
        />
      )}
      {validationError || error ? (
        <span role="alert" className="text-xs" style={{ color: "var(--danger)" }}>
          {validationError ?? error}
        </span>
      ) : null}
    </Card>
  );
}

export default function IdentityPersonalitySection() {
  return (
    <>
      <SettingsSectionHeader
        title="Identity & personality"
        description="Define the identity, tone, and boundaries Matrix uses when it works with you."
      />
      <SoulEditor />
    </>
  );
}
