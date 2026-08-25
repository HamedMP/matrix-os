import { Laptop, Rabbit } from "lucide-react";
import { useEffect, useState } from "react";
import type { CompanionPreferences } from "../../../../../shared/companion";
import { invoke } from "../../../lib/operator";

const LOAD_ERROR = "Companion settings are unavailable.";
const SAVE_ERROR = "Companion settings could not be saved.";

function HostOption({
  title,
  description,
  checked,
  disabled,
  icon,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex items-center gap-4 rounded-xl border p-4 ${disabled ? "opacity-55" : "cursor-pointer hover:bg-[var(--bg-hover)]"}`}
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
    >
      <span
        className="flex size-10 shrink-0 items-center justify-center rounded-xl"
        style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {title}
        </strong>
        <span className="mt-0.5 block text-xs leading-relaxed" style={{ color: "var(--text-tertiary)" }}>
          {description}
        </span>
      </span>
      <input
        type="checkbox"
        aria-label={title}
        checked={checked}
        disabled={disabled}
        className="size-4 accent-[var(--accent)]"
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

export default function CompanionSection() {
  const [preferences, setPreferences] = useState<CompanionPreferences | null>(null);
  const [supportsNotch, setSupportsNotch] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void invoke("companion:get-preferences", {})
      .then((result) => {
        if (!active) return;
        setPreferences(result.preferences);
        setSupportsNotch(result.supportsNotch);
      })
      .catch((loadError: unknown) => {
        console.warn("[companion] preferences load failed", loadError instanceof Error ? loadError.name : typeof loadError);
        if (active) setError(LOAD_ERROR);
      });
    return () => {
      active = false;
    };
  }, []);

  const save = async (next: CompanionPreferences) => {
    if (!preferences || saving) return;
    const previous = preferences;
    setPreferences(next);
    setSaving(true);
    setError(null);
    try {
      await invoke("companion:set-preferences", { preferences: next });
    } catch (saveError: unknown) {
      console.warn("[companion] preferences save failed", saveError instanceof Error ? saveError.name : typeof saveError);
      setPreferences(previous);
      setError(SAVE_ERROR);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h3 className="text-xl font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
          Companion
        </h3>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
          Keep Hermes one gesture away, even while Matrix OS is in the background.
        </p>
      </div>

      {preferences ? (
        <div className="flex flex-col gap-3">
          <HostOption
            title="Floating rabbit"
            description="A movable Rabbit panel that stays visible across desktops and full-screen apps."
            checked={preferences.rabbitEnabled}
            disabled={saving || (preferences.rabbitEnabled && !preferences.notchEnabled)}
            icon={<Rabbit size={19} aria-hidden />}
            onChange={(rabbitEnabled) => void save({ ...preferences, rabbitEnabled })}
          />
          <HostOption
            title="MacBook notch"
            description={supportsNotch
              ? "A compact Hermes control centered around the MacBook camera housing."
              : "Available in the macOS desktop app."}
            checked={preferences.notchEnabled}
            disabled={!supportsNotch || saving || (preferences.notchEnabled && !preferences.rabbitEnabled)}
            icon={<Laptop size={19} aria-hidden />}
            onChange={(notchEnabled) => void save({ ...preferences, notchEnabled })}
          />
        </div>
      ) : error ? null : (
        <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>Loading companion settings…</p>
      )}

      {error ? <p role="alert" className="text-sm" style={{ color: "var(--danger)" }}>{error}</p> : null}

      <div
        className="rounded-xl border px-4 py-3 text-xs leading-relaxed"
        style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)", background: "var(--bg-sunken)" }}
      >
        Press <kbd className="font-mono">⌘⇧Space</kbd> to hide or restore every enabled companion.
        Prompts still use your signed-in Matrix runtime; no credentials are exposed to either panel.
      </div>
    </section>
  );
}
