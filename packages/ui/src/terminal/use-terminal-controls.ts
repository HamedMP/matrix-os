import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  resolveTerminalShortcut,
  TerminalKeyboardPreferencesResponseSchema,
  TerminalKeyboardPreferencesSchema,
  TerminalPaneActionSchema,
  type TerminalKeyboardPreferences,
  type TerminalPaneAction,
} from "@matrix-os/contracts";
export interface TerminalControlsTransport {
  getPreferences(): Promise<unknown>;
  savePreferences(keyboard: TerminalKeyboardPreferences): Promise<unknown>;
  paneAction(sessionName: string, action: TerminalPaneAction): Promise<unknown>;
}
export interface TerminalControlsOptions {
  sessionName: string | null;
  enabled: boolean;
  paneActionsEnabled?: boolean;
  isMac: boolean;
  transport: TerminalControlsTransport | null;
  sendInput(data: string): void;
  focus(): void;
}
export interface TerminalControlsState {
  sessionName: string | null;
  enabled: boolean;
  paneActionsEnabled: boolean;
  isMac: boolean;
  busy: boolean;
  saving: boolean;
  error: string | null;
  prefixActive: boolean;
  preferences: TerminalKeyboardPreferences;
  handleKeyEvent(event: KeyboardEvent): boolean;
  runAction(action: TerminalPaneAction): Promise<void>;
  savePreferences(preferences: TerminalKeyboardPreferences): Promise<void>;
}
const PreferencesResponse = TerminalKeyboardPreferencesResponseSchema;
export function useTerminalControls(
  options: TerminalControlsOptions,
): TerminalControlsState {
  const { sessionName, enabled, isMac, transport, sendInput, focus } = options;
  const paneActionsEnabled =
    enabled &&
    options.paneActionsEnabled !== false &&
    !!sessionName &&
    !!transport;
  const [preferences, setPreferences] = useState<TerminalKeyboardPreferences>(
    () => TerminalKeyboardPreferencesSchema.parse({}),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [prefixActive, setPrefixActive] = useState(false);
  const generation = useRef(0);
  const pendingAction = useRef(false);
  const pendingSave = useRef(false);
  const prefixUntil = useRef(0);
  const saveRevision = useRef(0);
  useLayoutEffect(() => {
    generation.current += 1;
    prefixUntil.current = 0;
    setPrefixActive(false);
    setBusy(pendingAction.current);
    setSaving(pendingSave.current);
    setError(null);
    return () => {
      generation.current += 1;
      prefixUntil.current = 0;
    };
  }, [sessionName, transport, enabled]);
  useEffect(() => {
    if (!transport || !enabled) return;
    let cancelled = false;
    const revision = saveRevision.current;
    void (async () => {
      try {
        const result = PreferencesResponse.parse(
          await transport.getPreferences(),
        );
        if (!cancelled && revision === saveRevision.current)
          setPreferences(result.preferences.keyboard);
      } catch (err) {
        console.warn("[terminal-controls] preferences unavailable", err);
        if (!cancelled) setError("Keyboard settings could not be loaded.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [transport, enabled]);
  useEffect(() => {
    if (!prefixActive) return;
    const timer = setTimeout(() => {
      prefixUntil.current = 0;
      setPrefixActive(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [prefixActive]);
  const runAction = useCallback(
    async (action: TerminalPaneAction) => {
      if (
        !paneActionsEnabled ||
        !sessionName ||
        !transport ||
        pendingAction.current
      )
        return;
      const current = generation.current;
      pendingAction.current = true;
      setBusy(true);
      setError(null);
      try {
        await transport.paneAction(
          sessionName,
          TerminalPaneActionSchema.parse(action),
        );
        if (current === generation.current) focus();
      } catch (err) {
        console.warn("[terminal-controls] pane action failed", err);
        if (current === generation.current)
          setError("The pane action could not be completed.");
      } finally {
        pendingAction.current = false;
        setBusy(false);
      }
    },
    [paneActionsEnabled, sessionName, transport, focus],
  );
  const savePreferences = useCallback(
    async (next: TerminalKeyboardPreferences) => {
      if (!transport || !enabled || pendingSave.current) return;
      const current = generation.current;
      pendingSave.current = true;
      setSaving(true);
      saveRevision.current += 1;
      setError(null);
      try {
        const validated = TerminalKeyboardPreferencesSchema.parse(next);
        const result = PreferencesResponse.parse(
          await transport.savePreferences(validated),
        );
        if (current === generation.current)
          setPreferences(result.preferences.keyboard);
      } catch (err) {
        console.warn("[terminal-controls] keyboard save failed", err);
        if (current === generation.current)
          setError(
            "Keyboard settings could not be saved. Check for invalid or duplicate shortcuts.",
          );
      } finally {
        pendingSave.current = false;
        setSaving(false);
      }
    },
    [transport, enabled],
  );
  const handleKeyEvent = useCallback(
    (event: KeyboardEvent) => {
      if (
        !enabled ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.getModifierState?.("AltGraph")
      )
        return true;
      const action = resolveTerminalShortcut(
        {
          ...event,
          type: event.type,
          key: event.key,
          isMac,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
          isComposing: event.isComposing,
        },
        preferences,
        prefixUntil.current > Date.now(),
      );
      if (!action) return true;
      event.preventDefault();
      event.stopPropagation();
      if (action.kind === "keep-prefix") return false;
      if (action.kind === "prefix") {
        prefixUntil.current = Date.now() + 2000;
        setPrefixActive(true);
        return false;
      }
      prefixUntil.current = 0;
      setPrefixActive(false);
      if (action.kind === "input") {
        try {
          sendInput(action.data);
        } catch (err) {
          console.warn("[terminal-controls] input failed", err);
          setError("Terminal input could not be sent.");
        }
      } else if (action.kind === "pane") {
        if (paneActionsEnabled) void runAction(action.action);
        else setError("Pane controls are unavailable for this terminal.");
      }
      return false;
    },
    [enabled, isMac, preferences, paneActionsEnabled, runAction, sendInput],
  );
  return {
    sessionName,
    enabled,
    paneActionsEnabled,
    isMac,
    busy,
    saving,
    error,
    prefixActive,
    preferences,
    handleKeyEvent,
    runAction,
    savePreferences,
  };
}
