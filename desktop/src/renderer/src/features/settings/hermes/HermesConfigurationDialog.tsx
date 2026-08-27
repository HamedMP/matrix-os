import {
  HermesConfigValueSchema,
  type HermesConfiguration,
  type HermesEnvironment,
} from "@matrix-os/contracts";
import { RefreshCw, Search, Sparkles, SquareTerminal, X } from "@renderer/lib/hugeicons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog } from "../../../design/primitives";
import { invoke } from "../../../lib/operator";
import { HermesCredentialRow } from "./HermesCredentialRow";
import { HermesSettingEditor } from "./HermesSettingEditor";
import {
  configValueAt,
  configurationCategories,
  isCurrentRequestRevision,
  matchingConfigurationFields,
  matchingCredentials,
  setConfigValue,
  valuesEqual,
} from "./hermes-form-model";

interface HermesConfigurationDialogProps {
  open: boolean;
  version?: string;
  onClose: () => void;
  onOpenSetupTerminal: () => Promise<void> | void;
  onConfigurationChanged: () => void;
}

const LOAD_ERROR = "Hermes configuration is unavailable.";
const SAVE_ERROR = "Hermes configuration could not be saved.";
const CREDENTIAL_ERROR = "Hermes credential could not be updated.";
// Matches the shared HermesConfigurationSchema field limit. Invalid paths can
// only originate from rendered, schema-validated fields.
const MAX_INVALID_PATHS = 1_024;

export function HermesConfigurationDialog({
  open,
  version,
  onClose,
  onOpenSetupTerminal,
  onConfigurationChanged,
}: HermesConfigurationDialogProps) {
  const [configuration, setConfiguration] = useState<HermesConfiguration | null>(null);
  const [environment, setEnvironment] = useState<HermesEnvironment>({});
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [tab, setTab] = useState<"settings" | "credentials">("settings");
  const [category, setCategory] = useState("");
  const [settingsSearch, setSettingsSearch] = useState("");
  const [credentialSearch, setCredentialSearch] = useState("");
  const [invalidPaths, setInvalidPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<"refresh" | "close" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRevision = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const revision = ++requestRevision.current;
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const [nextConfiguration, nextEnvironment] = await Promise.all([
        invoke("runtime:get-hermes-configuration", {}),
        invoke("runtime:get-hermes-environment", {}),
      ]);
      if (!isCurrentRequestRevision(requestRevision.current, revision)) return;
      setConfiguration(nextConfiguration);
      setEnvironment(nextEnvironment);
      setDraft(structuredClone(nextConfiguration.config));
      setInvalidPaths([]);
      setCategory(configurationCategories(nextConfiguration)[0]?.id ?? "");
    } catch (loadError) {
      if (isCurrentRequestRevision(requestRevision.current, revision)) {
        console.warn("Hermes Desktop configuration load failed", loadError instanceof Error ? loadError.name : "UnknownError");
        setError(LOAD_ERROR);
      }
    } finally {
      if (isCurrentRequestRevision(requestRevision.current, revision)) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!open) {
      ++requestRevision.current;
      setConfiguration(null);
      setEnvironment({});
      setDraft({});
      return;
    }
    void load(false);
  }, [open, load]);

  const categories = useMemo(
    () => configuration ? configurationCategories(configuration) : [],
    [configuration],
  );
  const visibleFields = useMemo(
    () => configuration ? matchingConfigurationFields(configuration, settingsSearch, category) : [],
    [configuration, settingsSearch, category],
  );
  const visibleCredentials = useMemo(
    () => matchingCredentials(environment, credentialSearch),
    [environment, credentialSearch],
  );
  const changes = useMemo(() => {
    if (!configuration) return [];
    return Object.keys(configuration.fields).flatMap((path) => {
      const current = configValueAt(configuration.config, path);
      const next = configValueAt(draft, path);
      if (valuesEqual(current, next)) return [];
      const parsed = HermesConfigValueSchema.safeParse(next);
      return parsed.success ? [{ path, value: parsed.data }] : [];
    });
  }, [configuration, draft]);
  const dirtyPathCount = changes.reduce(
    (count, change) => count + (invalidPaths.includes(change.path) ? 0 : 1),
    invalidPaths.length,
  );
  const isDirty = dirtyPathCount > 0;

  const requestRefresh = () => {
    if (isDirty) setConfirmation("refresh");
    else void load(true);
  };

  const requestClose = () => {
    if (isDirty) setConfirmation("close");
    else onClose();
  };

  const save = async () => {
    if (!configuration || changes.length === 0 || invalidPaths.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("runtime:update-hermes-configuration", { changes });
      setConfiguration({ ...configuration, config: structuredClone(draft) });
      onConfigurationChanged();
    } catch (saveError) {
      console.warn("Hermes Desktop configuration save failed", saveError instanceof Error ? saveError.name : "UnknownError");
      setError(SAVE_ERROR);
    } finally {
      setSaving(false);
    }
  };

  const saveCredential = async (key: string, value: string): Promise<boolean> => {
    setCredentialBusy(true);
    setError(null);
    try {
      await invoke("runtime:set-hermes-credential", { key, value });
      setEnvironment((current) => ({
        ...current,
        [key]: { ...current[key]!, is_set: true, redacted_value: "Configured" },
      }));
      onConfigurationChanged();
      return true;
    } catch (credentialError) {
      console.warn("Hermes Desktop credential save failed", credentialError instanceof Error ? credentialError.name : "UnknownError");
      setError(CREDENTIAL_ERROR);
      return false;
    } finally {
      setCredentialBusy(false);
    }
  };

  const removeCredential = async (key: string): Promise<boolean> => {
    setCredentialBusy(true);
    setError(null);
    try {
      await invoke("runtime:remove-hermes-credential", { key });
      setEnvironment((current) => ({
        ...current,
        [key]: { ...current[key]!, is_set: false, redacted_value: undefined },
      }));
      onConfigurationChanged();
      return true;
    } catch (credentialError) {
      console.warn("Hermes Desktop credential removal failed", credentialError instanceof Error ? credentialError.name : "UnknownError");
      setError(CREDENTIAL_ERROR);
      return false;
    } finally {
      setCredentialBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={requestClose} width={980} placement="center">
      <div className="relative flex h-[min(720px,82vh)] flex-col overflow-hidden">
        <header className="flex items-start justify-between border-b px-5 py-4" style={{ borderColor: "var(--border-subtle)" }}>
          <div className="flex items-start gap-3">
            <div className="rounded-lg p-2" style={{ background: "var(--accent-muted)", color: "var(--accent)" }}>
              <Sparkles size={19} />
            </div>
            <div>
              <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Configure Hermes</h2>
              <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                Settings and credentials for this Matrix computer
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {version ? <span className="rounded-full border px-2 py-1 text-xs" style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}>Version {version}</span> : null}
            <Button variant="ghost" disabled={loading || refreshing} onClick={requestRefresh}>
              <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
            <Button
              variant="ghost"
              className="h-7 w-7 px-0"
              aria-label="Close Hermes configuration"
              onClick={requestClose}
            >
              <X size={16} />
            </Button>
          </div>
        </header>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm" style={{ color: "var(--text-secondary)" }}>
            Loading Hermes configuration…
          </div>
        ) : !configuration ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <p role="alert" className="text-sm" style={{ color: "var(--danger)" }}>{error ?? LOAD_ERROR}</p>
            <div className="flex gap-2">
              <Button onClick={() => void load(false)}>Try again</Button>
              <Button variant="primary" aria-label="Open setup terminal" onClick={() => void onOpenSetupTerminal()}>
                <SquareTerminal size={14} />Open setup terminal
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between border-b px-5" style={{ borderColor: "var(--border-subtle)" }}>
              <div role="tablist" className="flex gap-1">
                {(["settings", "credentials"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={tab === value}
                    className="border-b-2 px-3 py-3 text-sm font-medium capitalize"
                    style={{
                      borderColor: tab === value ? "var(--accent)" : "transparent",
                      color: tab === value ? "var(--text-primary)" : "var(--text-tertiary)",
                    }}
                    onClick={() => setTab(value)}
                  >
                    {value === "settings" ? "Settings" : "Credentials"}
                  </button>
                ))}
              </div>
              <label className="relative w-80">
                <Search size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2" style={{ color: "var(--text-tertiary)" }} />
                <span className="sr-only">Search {tab}</span>
                <input
                  aria-label={`Search Hermes ${tab}`}
                  className="h-8 w-full rounded-md border bg-transparent pr-2 pl-8 text-sm outline-none"
                  style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
                  placeholder={`Search ${tab}…`}
                  value={tab === "settings" ? settingsSearch : credentialSearch}
                  onChange={(event) => tab === "settings" ? setSettingsSearch(event.target.value) : setCredentialSearch(event.target.value)}
                />
              </label>
            </div>

            <div className="flex min-h-0 flex-1">
              {tab === "settings" ? (
                <>
                  <aside className="w-52 shrink-0 overflow-y-auto border-r p-3" style={{ borderColor: "var(--border-subtle)" }}>
                    {categories.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        aria-label={item.label}
                        className="mb-1 flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm"
                        style={{
                          background: category === item.id ? "var(--accent-muted)" : "transparent",
                          color: category === item.id ? "var(--text-primary)" : "var(--text-secondary)",
                        }}
                        onClick={() => setCategory(item.id)}
                      >
                        {item.label}<span className="text-xs" style={{ color: "var(--text-tertiary)" }}>{item.count}</span>
                      </button>
                    ))}
                  </aside>
                  <main className="min-w-0 flex-1 space-y-3 overflow-y-auto p-4">
                    {visibleFields.map(([path, field]) => (
                      <HermesSettingEditor
                        key={path}
                        path={path}
                        field={field}
                        value={configValueAt(draft, path) ?? configValueAt(configuration.defaults, path)}
                        defaultValue={configValueAt(configuration.defaults, path)}
                        onChange={(value) => setDraft((current) => setConfigValue(current, path, value))}
                        onValidityChange={(valid) => setInvalidPaths((current) => {
                          if (valid) return current.filter((item) => item !== path);
                          if (current.includes(path)) return current;
                          if (current.length >= MAX_INVALID_PATHS) return current;
                          return [...current, path];
                        })}
                      />
                    ))}
                  </main>
                </>
              ) : (
                <main className="min-w-0 flex-1 space-y-3 overflow-y-auto p-4">
                  {visibleCredentials.map(([key, entry]) => (
                    <HermesCredentialRow
                      key={key}
                      credentialKey={key}
                      entry={entry}
                      busy={credentialBusy}
                      onSave={saveCredential}
                      onRemove={removeCredential}
                    />
                  ))}
                </main>
              )}
            </div>

            <footer className="flex items-center justify-between border-t px-5 py-3" style={{ borderColor: "var(--border-subtle)" }}>
              <div>
                {error ? <span role="alert" className="text-xs" style={{ color: "var(--danger)" }}>{error}</span> : (
                  <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                    {dirtyPathCount} unsaved {dirtyPathCount === 1 ? "change" : "changes"}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  aria-label="Discard Hermes changes"
                  disabled={!isDirty || saving}
                  onClick={() => {
                    setDraft(structuredClone(configuration.config));
                    setInvalidPaths([]);
                  }}
                >
                  Discard
                </Button>
                <Button
                  variant="primary"
                  aria-label="Save Hermes settings"
                  disabled={changes.length === 0 || invalidPaths.length > 0 || saving}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </footer>
          </>
        )}
        <Dialog
          open={confirmation !== null}
          onClose={() => setConfirmation(null)}
          width={400}
          role="alertdialog"
          title={confirmation === "refresh" ? "Confirm refresh" : "Confirm close"}
        >
          {confirmation ? (
            <div className="p-5">
              <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                {confirmation === "refresh"
                  ? "Discard unsaved changes and refresh?"
                  : "Discard unsaved changes and close?"}
              </h3>
              <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>
                Your unsaved Hermes setting changes will be lost.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirmation(null)}>Cancel</Button>
                <Button
                  variant="danger"
                  aria-label={confirmation === "refresh" ? "Discard and refresh" : "Discard and close"}
                  onClick={() => {
                    const action = confirmation;
                    setConfirmation(null);
                    if (action === "refresh") void load(true);
                    else onClose();
                  }}
                >
                  {confirmation === "refresh" ? "Discard and refresh" : "Discard and close"}
                </Button>
              </div>
            </div>
          ) : null}
        </Dialog>
      </div>
    </Dialog>
  );
}
