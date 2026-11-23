import { useEffect } from "react";
import { ShortcutSettings } from "@matrix-os/ui/shortcuts";
import { invoke } from "../../../lib/operator";
import { useShortcuts } from "../../../stores/shortcuts";
import { Card, SettingsSectionHeader } from "./section-kit";
import "./shortcuts-section.css";

// The main process suspends shortcut handling while a row records, so a key
// press reaches the recorder instead of firing an action.
function reportRecording(recording: boolean): void {
  invoke("shortcuts:set-recording", { recording }).catch((error: unknown) => {
    console.warn("[shortcuts] could not report recording state:", error);
  });
}

export default function ShortcutsSection() {
  const snapshot = useShortcuts((state) => state.snapshot);
  const error = useShortcuts((state) => state.error);
  const load = useShortcuts((state) => state.load);
  const save = useShortcuts((state) => state.save);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="desktop-shortcuts">
      <SettingsSectionHeader title="Shortcuts" />
      {snapshot === null ? (
        <Card>
          <p role="status" className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Loading shortcuts…
          </p>
        </Card>
      ) : (
        <ShortcutSettings
          platform={snapshot.platform}
          overrides={snapshot.overrides}
          error={error}
          onChange={save}
          onRecordingChange={reportRecording}
        />
      )}
    </div>
  );
}
