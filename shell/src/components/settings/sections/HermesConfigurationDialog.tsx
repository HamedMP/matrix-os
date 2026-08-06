"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  KeyRoundIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import {
  configValueAt,
  HermesConfigurationError,
  loadHermesConfiguration,
  loadHermesEnvironment,
  removeHermesCredential,
  saveHermesConfiguration,
  saveHermesCredential,
  type HermesConfigField,
  type HermesConfigValue,
  type HermesConfiguration,
  type HermesEnvironment,
} from "@/lib/hermes-configuration";

interface HermesConfigurationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version?: string;
}

function titleCase(value: string): string {
  return value.split(/[._-]/).map((part) => (
    part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)
  )).join(" ");
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function setConfigValue(config: Record<string, unknown>, path: string, value: HermesConfigValue) {
  const updated = structuredClone(config);
  const segments = path.split(".");
  let target = updated;
  for (const segment of segments.slice(0, -1)) {
    const existing = target[segment];
    if (existing === null || typeof existing !== "object" || Array.isArray(existing)) target[segment] = {};
    target = target[segment] as Record<string, unknown>;
  }
  target[segments.at(-1)!] = value;
  return updated;
}

function isConfigValue(value: unknown): value is HermesConfigValue {
  return typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
    || (Array.isArray(value) && value.every((entry) => (
      typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
    )));
}

function parseListValue(text: string): Array<string | number | boolean> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      console.warn("Hermes list setting parsing failed", error instanceof Error ? error.name : "UnknownError");
    }
    return null;
  }
  return isConfigValue(parsed) && Array.isArray(parsed) ? parsed : null;
}

function fieldTextValue(field: HermesConfigField, value: unknown): string {
  if (field.type === "list") return JSON.stringify(value ?? [], null, 2);
  if (field.type === "number" && typeof value === "number") return String(value);
  return "";
}

async function attemptCredentialMutation(operation: () => Promise<void>, action: "save" | "remove"): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error) {
    console.warn(
      action === "save" ? "Hermes credential save failed" : "Hermes credential removal failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return false;
  }
}

function configurationCategories(configuration: HermesConfiguration | null) {
  if (!configuration) return [];
  // Bounded by the gateway's 1,024-field schema cap.
  const counts = new Map<string, number>();
  for (const field of Object.values(configuration.fields)) {
    counts.set(field.category, (counts.get(field.category) ?? 0) + 1);
  }
  const ordered = configuration.categoryOrder.filter((entry) => counts.has(entry));
  const orderedSet = new Set(ordered);
  const remaining = [...counts.keys()].filter((entry) => !orderedSet.has(entry)).sort();
  return [...ordered, ...remaining].map((id) => ({ id, count: counts.get(id) ?? 0 }));
}

function matchingConfigurationFields(configuration: HermesConfiguration | null, search: string, category: string) {
  if (!configuration) return [];
  const query = search.trim().toLowerCase();
  return Object.entries(configuration.fields).filter(([path, field]) => (
    query
      ? `${path} ${field.description} ${field.category}`.toLowerCase().includes(query)
      : field.category === category
  ));
}

function matchingCredentials(environment: HermesEnvironment, search: string) {
  const query = search.trim().toLowerCase();
  return Object.entries(environment).filter(([key, entry]) => (
    !entry.channel_managed
    && (!query || `${key} ${entry.provider_label} ${entry.description}`.toLowerCase().includes(query))
  )).sort(([, left], [, right]) => (
    Number(right.is_set) - Number(left.is_set) || left.provider_label.localeCompare(right.provider_label)
  ));
}

function FieldEditor({
  path,
  field,
  value,
  defaultValue,
  onChange,
  onValidityChange,
  inputText,
  invalid,
  onInputTextChange,
}: {
  path: string;
  field: HermesConfigField;
  value: unknown;
  defaultValue: unknown;
  onChange: (value: HermesConfigValue) => void;
  onValidityChange: (valid: boolean) => void;
  inputText: string;
  invalid: boolean;
  onInputTextChange: (value: string) => void;
}) {
  const inputId = `hermes-setting-${path.replaceAll(".", "-")}`;
  const canRestore = isConfigValue(defaultValue) && !valuesEqual(value, defaultValue);

  let control;
  if (field.type === "boolean") {
    control = (
      <Switch
        id={inputId}
        aria-label={field.description}
        checked={value === true}
        onCheckedChange={(checked) => {
          onValidityChange(true);
          onChange(checked);
        }}
      />
    );
  } else if (field.type === "number") {
    control = (
      <Input
        id={inputId}
        aria-label={field.description}
        type="number"
        value={inputText}
        aria-invalid={invalid}
        onChange={(event) => {
          const raw = event.target.value;
          onInputTextChange(raw);
          if (raw.trim().length === 0) {
            onValidityChange(false);
            return;
          }
          const next = Number(raw);
          if (!Number.isFinite(next)) {
            onValidityChange(false);
            return;
          }
          onValidityChange(true);
          onChange(next);
        }}
      />
    );
  } else if (field.type === "select") {
    control = (
      <select
        id={inputId}
        aria-label={field.description}
        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={typeof value === "string" ? value : ""}
        onChange={(event) => {
          onValidityChange(true);
          onChange(event.target.value);
        }}
      >
        {field.options?.map((option) => (
          <option key={option || "default"} value={option}>{option || "Automatic"}</option>
        ))}
      </select>
    );
  } else if (field.type === "list") {
    control = (
      <div className="space-y-1.5">
        <Textarea
          id={inputId}
          aria-label={field.description}
          className="min-h-24 font-mono text-xs"
          value={inputText}
          aria-invalid={invalid}
          onChange={(event) => {
            const nextText = event.target.value;
            onInputTextChange(nextText);
            const parsed = parseListValue(nextText);
            if (parsed === null) {
              onValidityChange(false);
              return;
            }
            onValidityChange(true);
            onChange(parsed);
          }}
        />
        <p className={invalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {invalid ? "Enter a valid JSON list before saving." : "JSON list · strings, numbers, and booleans are supported."}
        </p>
      </div>
    );
  } else {
    control = (
      <Input
        id={inputId}
        aria-label={field.description}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => {
          onValidityChange(true);
          onChange(event.target.value);
        }}
      />
    );
  }

  return (
    <article className="rounded-xl border border-border/60 bg-background/50 p-4 transition-colors focus-within:border-ember/40">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor={inputId} className="text-sm font-medium">{field.description}</Label>
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={path}>{path}</p>
        </div>
        {canRestore && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-2 text-xs"
            aria-label={`Restore default for ${field.description}`}
            onClick={() => {
              if (field.type === "list" || field.type === "number") {
                onInputTextChange(fieldTextValue(field, defaultValue));
              }
              onValidityChange(true);
              onChange(defaultValue);
            }}
          >
            <RotateCcwIcon className="size-3" /> Default
          </Button>
        )}
      </div>
      <div className={field.type === "boolean" ? "mt-3 flex justify-end" : "mt-3"}>{control}</div>
      {field.type === "number" && invalid && <p className="mt-1.5 text-xs text-destructive">Enter a number before saving.</p>}
    </article>
  );
}

function CredentialRow({
  envKey,
  entry,
  onCommitted,
}: {
  envKey: string;
  entry: HermesEnvironment[string];
  onCommitted: (isSet: boolean) => Promise<boolean>;
}) {
  const label = entry.provider_label || titleCase(envKey.replace(/_(?:API_)?KEY$|_TOKEN$/, ""));
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const save = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    void attemptCredentialMutation(() => saveHermesCredential(envKey, value), "save").then((saved) => {
      if (saved) {
        setValue("");
        return onCommitted(true).then((refreshed) => {
          if (!refreshed) setFeedback("Credential saved. Live status could not be refreshed.");
        }).catch((refreshError: unknown) => {
          console.warn("Hermes credential status refresh failed", refreshError instanceof Error ? refreshError.name : "UnknownError");
          setFeedback("Credential saved. Live status could not be refreshed.");
        });
      }
      setError("Credential could not be saved.");
    }).finally(() => {
      setBusy(false);
    });
  };

  const remove = () => {
    if (busy) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setBusy(true);
    setError(null);
    setFeedback(null);
    void attemptCredentialMutation(() => removeHermesCredential(envKey), "remove").then((removed) => {
      if (removed) {
        setConfirmRemove(false);
        return onCommitted(false).then((refreshed) => {
          if (!refreshed) setFeedback("Credential removed. Live status could not be refreshed.");
        }).catch((refreshError: unknown) => {
          console.warn("Hermes credential status refresh failed", refreshError instanceof Error ? refreshError.name : "UnknownError");
          setFeedback("Credential removed. Live status could not be refreshed.");
        });
      }
      setError("Credential could not be removed.");
    }).finally(() => {
      setBusy(false);
    });
  };

  return (
    <article className="rounded-xl border border-border/60 bg-background/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold">{label}</h4>
          <p className="mt-1 text-xs text-muted-foreground">{entry.description || envKey}</p>
        </div>
        <Badge variant="secondary" className={entry.is_set ? "bg-forest/10 text-forest" : undefined}>
          {entry.is_set ? <CheckCircle2Icon className="size-3" /> : <KeyRoundIcon className="size-3" />}
          {entry.is_set ? "Connected" : "Not set"}
        </Badge>
      </div>
      {entry.is_set && entry.redacted_value && (
        <p className="mt-3 rounded-md bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">{entry.redacted_value}</p>
      )}
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
        <div>
          <Label htmlFor={`hermes-env-${envKey}`} className="sr-only">New {label} API key</Label>
          <Input
            id={`hermes-env-${envKey}`}
            type="password"
            autoComplete="off"
            placeholder={entry.is_set ? "Replace credential" : "Paste credential"}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <Button size="sm" disabled={busy || value.length === 0} aria-label={`Save ${label} credential`} onClick={save}>
          Save
        </Button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] text-muted-foreground">{envKey}</span>
        {entry.is_set && (
          <Button
            size="sm"
            variant={confirmRemove ? "destructive" : "ghost"}
            className="h-7 px-2 text-xs"
            disabled={busy}
            aria-label={`Remove ${label} credential`}
            onClick={remove}
          >
            <Trash2Icon className="size-3" /> {confirmRemove ? "Confirm remove" : "Remove"}
          </Button>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      {feedback && <p role="status" className="mt-2 text-xs text-warning">{feedback}</p>}
    </article>
  );
}

export function HermesConfigurationDialog({ open, onOpenChange, version }: HermesConfigurationDialogProps) {
  const [configuration, setConfiguration] = useState<HermesConfiguration | null>(null);
  const [environment, setEnvironment] = useState<HermesEnvironment>({});
  const [drafts, setDrafts] = useState<Record<string, HermesConfigValue>>({});
  const [invalidFields, setInvalidFields] = useState<Record<string, true>>({});
  const [fieldTexts, setFieldTexts] = useState<Record<string, string>>({});
  const [category, setCategory] = useState("general");
  const [search, setSearch] = useState("");
  const [credentialSearch, setCredentialSearch] = useState("");
  const [tab, setTab] = useState("settings");
  const [loading, setLoading] = useState(open);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmation, setConfirmation] = useState<"refresh" | "close" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [previousOpen, setPreviousOpen] = useState(open);
  const hasLoadedConfiguration = useRef(false);
  const environmentRevision = useRef(0);
  const configurationRevision = useRef(0);
  const pendingConfigValues = useRef<Record<string, HermesConfigValue>>({});
  const latestConfiguration = useRef(configuration);
  latestConfiguration.current = configuration;

  if (open !== previousOpen) {
    setPreviousOpen(open);
    if (open) {
      setLoading(true);
      setError(null);
      setNotice(null);
      setTab("settings");
    }
  }

  const commitEnvironmentMutation = async (envKey: string, isSet: boolean): Promise<boolean> => {
    const revision = environmentRevision.current + 1;
    environmentRevision.current = revision;
    setEnvironment((current) => {
      const entry = current[envKey];
      if (!entry) return current;
      return {
        ...current,
        [envKey]: {
          ...entry,
          is_set: isSet,
          redacted_value: "",
        },
      };
    });
    try {
      const nextEnvironment = await loadHermesEnvironment();
      if (revision === environmentRevision.current) setEnvironment(nextEnvironment);
      return true;
    } catch (refreshError) {
      if (revision !== environmentRevision.current) return true;
      console.warn("Hermes credential status refresh failed", refreshError instanceof Error ? refreshError.name : "UnknownError");
      return false;
    }
  };

  const loadData = async (discardDrafts: boolean, mode: "initial" | "refresh") => {
    const revision = configurationRevision.current + 1;
    configurationRevision.current = revision;
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    setError(null);
    const environmentReadRevision = environmentRevision.current;
    try {
      const [nextConfig, nextEnv] = await Promise.all([loadHermesConfiguration(), loadHermesEnvironment()]);
      if (revision !== configurationRevision.current) return;
      setConfiguration(nextConfig);
      if (environmentReadRevision === environmentRevision.current) setEnvironment(nextEnv);
      setDrafts((current) => discardDrafts ? {} : Object.fromEntries(
        Object.entries(current).filter(([path]) => Object.hasOwn(nextConfig.fields, path)),
      ));
      setInvalidFields((current) => discardDrafts ? {} : Object.fromEntries(
        Object.entries(current).filter(([path]) => Object.hasOwn(nextConfig.fields, path)),
      ));
      setFieldTexts((current) => discardDrafts ? {} : Object.fromEntries(
        Object.entries(current).filter(([path]) => Object.hasOwn(nextConfig.fields, path)),
      ));
      setNotice(null);
      if (!hasLoadedConfiguration.current) {
        hasLoadedConfiguration.current = true;
        setCategory(nextConfig.categoryOrder[0] ?? Object.values(nextConfig.fields)[0]?.category ?? "general");
      }
    } catch (loadError) {
      if (revision === configurationRevision.current) {
        console.warn("Hermes configuration refresh failed", loadError instanceof Error ? loadError.name : "UnknownError");
        setError(loadError instanceof HermesConfigurationError ? loadError.message : "Hermes configuration is unavailable.");
      }
    } finally {
      if (revision === configurationRevision.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  useEffect(() => {
    if (!open) {
      configurationRevision.current += 1;
      return;
    }
    void loadData(false, "initial");
    return () => {
      configurationRevision.current += 1;
    };
    // Opening is the only automatic load. Explicit refreshes call loadData
    // directly and use the request revision to reject stale responses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const categories = configurationCategories(configuration);
  const visibleFields = matchingConfigurationFields(configuration, search, category);
  const visibleCredentials = matchingCredentials(environment, credentialSearch);
  const invalidFieldCount = Object.keys(invalidFields).length;
  const draftCount = Object.keys(drafts).length;

  const requestRefresh = () => {
    if (draftCount > 0 || invalidFieldCount > 0) setConfirmation("refresh");
    else void loadData(true, "refresh");
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      onOpenChange(true);
      return;
    }
    if (draftCount > 0 || invalidFieldCount > 0) {
      setConfirmation("close");
      return;
    }
    onOpenChange(false);
  };

  const save = async () => {
    if (!configuration || invalidFieldCount > 0) return;
    const changes = Object.entries(drafts).map(([path, value]) => ({ path, value }));
    if (changes.length === 0) return;
    const submittedFieldTexts = fieldTexts;
    pendingConfigValues.current = Object.fromEntries(changes.map(({ path, value }) => [path, value]));
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await saveHermesConfiguration(changes);
      setConfiguration((current) => {
        const latest = current ?? configuration;
        let updatedConfig = latest.config;
        for (const change of changes) updatedConfig = setConfigValue(updatedConfig, change.path, change.value);
        return { ...latest, config: updatedConfig };
      });
      setDrafts((current) => {
        const next = { ...current };
        for (const change of changes) {
          if (Object.hasOwn(current, change.path) && Object.is(current[change.path], change.value)) {
            delete next[change.path];
          }
        }
        return next;
      });
      setFieldTexts((current) => {
        const next = { ...current };
        for (const change of changes) {
          if (Object.hasOwn(submittedFieldTexts, change.path)
            && current[change.path] === submittedFieldTexts[change.path]) {
            delete next[change.path];
          }
        }
        return next;
      });
      setNotice("Hermes settings saved");
    } catch (saveError) {
      setError(saveError instanceof HermesConfigurationError ? saveError.message : "Hermes configuration could not be saved.");
      setDrafts((current) => {
        const next = { ...current };
        const authoritativeConfig = latestConfiguration.current?.config ?? configuration.config;
        for (const change of changes) {
          const storedValue = configValueAt(authoritativeConfig, change.path);
          if (!Object.hasOwn(current, change.path)) {
            if (!valuesEqual(change.value, storedValue)) next[change.path] = change.value;
          } else if (valuesEqual(current[change.path], storedValue)) {
            delete next[change.path];
          }
        }
        return next;
      });
    } finally {
      pendingConfigValues.current = {};
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex h-[min(86vh,820px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        style={{ zIndex: SHELL_Z_INDEX.popover }}
        overlayStyle={{ zIndex: SHELL_Z_INDEX.popover }}
      >
        <DialogHeader className="border-b border-border/60 bg-gradient-to-r from-ember/8 via-background to-forest/5 px-6 py-5 pr-14">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <DialogTitle className="flex items-center gap-2 text-xl">
                <SparklesIcon className="size-5 text-ember" /> Configure Hermes
              </DialogTitle>
              <DialogDescription className="mt-1.5">
                A friendly control center generated from the exact Hermes version installed on this computer.
              </DialogDescription>
            </div>
            <div className="flex items-center gap-2">
              {version && <Badge variant="outline">Version {version}</Badge>}
              <Button
                size="sm"
                variant="outline"
                aria-label="Refresh Hermes configuration"
                disabled={loading || refreshing}
                onClick={requestRefresh}
              >
                <RefreshCwIcon className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
                {refreshing ? "Refreshing…" : "Refresh"}
              </Button>
            </div>
          </div>
        </DialogHeader>

        {loading ? (
          <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" /> Reading Hermes capabilities
          </div>
        ) : error && !configuration ? (
          <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <AlertTriangleIcon className="size-6 text-destructive" />
            <p className="text-sm font-medium">{error}</p>
          </div>
        ) : configuration ? (
          <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
            <div className="flex items-center justify-between gap-3 border-b border-border/60 px-6 py-3">
              <TabsList>
                <TabsTrigger value="settings" onClick={() => {
                  setTab("settings");
                }}><Settings2Icon /> Settings</TabsTrigger>
                <TabsTrigger value="credentials" onClick={() => {
                  setTab("credentials");
                }}><KeyRoundIcon /> Credentials</TabsTrigger>
              </TabsList>
              <p className="hidden text-xs text-muted-foreground sm:block">
                {Object.keys(configuration.fields).length} settings discovered from this Hermes installation
              </p>
            </div>

            <TabsContent value="settings" className="min-h-0">
              <div className="grid h-full min-h-0 md:grid-cols-[220px_1fr]">
                <aside className="hidden min-h-0 border-r border-border/60 bg-muted/15 p-3 md:block">
                  <ScrollArea className="h-full">
                    <nav aria-label="Hermes setting categories" className="space-y-1 pr-2">
                      {categories.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          aria-label={`${titleCase(entry.id)}, ${entry.count} ${entry.count === 1 ? "setting" : "settings"}`}
                          aria-current={!search && category === entry.id ? "page" : undefined}
                          className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${!search && category === entry.id ? "bg-ember/10 font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
                          onClick={() => {
                            setSearch("");
                            setCategory(entry.id);
                          }}
                        >
                          <span>{titleCase(entry.id)}</span>
                          <span className="text-xs opacity-70">{entry.count}</span>
                        </button>
                      ))}
                    </nav>
                  </ScrollArea>
                </aside>
                <div className="flex min-h-0 flex-col">
                  <div className="border-b border-border/60 px-4 py-3 sm:px-5">
                    <select
                      aria-label="Hermes setting category"
                      className="mb-2 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm md:hidden"
                      value={category}
                      onChange={(event) => {
                        setSearch("");
                        setCategory(event.target.value);
                      }}
                    >
                      {categories.map((entry) => (
                        <option key={entry.id} value={entry.id}>{titleCase(entry.id)} ({entry.count})</option>
                      ))}
                    </select>
                    <div className="relative">
                      <SearchIcon className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
                      <Input
                        type="search"
                        aria-label="Search Hermes settings"
                        placeholder="Search all settings and command capabilities…"
                        className="pl-9"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                    </div>
                  </div>
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="space-y-3 p-4 pb-8 sm:p-5">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-semibold">{search ? "Search results" : titleCase(category)}</h3>
                          <p className="text-xs text-muted-foreground">{visibleFields.length} configurable {visibleFields.length === 1 ? "setting" : "settings"}</p>
                        </div>
                        {category === "security" && !search && (
                          <Badge variant="outline" className="text-warning"><ShieldCheckIcon className="size-3" /> Review carefully</Badge>
                        )}
                      </div>
                      {visibleFields.map(([path, field]) => {
                        const storedValue = configValueAt(configuration.config, path);
                        const value = Object.hasOwn(drafts, path) ? drafts[path] : storedValue;
                        return (
                          <FieldEditor
                            key={path}
                            path={path}
                            field={field}
                            value={value}
                            defaultValue={configValueAt(configuration.defaults, path)}
                            inputText={fieldTexts[path] ?? fieldTextValue(field, value)}
                            invalid={Object.hasOwn(invalidFields, path)}
                            onInputTextChange={(nextText) => {
                              setFieldTexts((current) => ({ ...current, [path]: nextText }));
                            }}
                            onValidityChange={(valid) => {
                              setInvalidFields((current) => {
                                if (valid) {
                                  if (!Object.hasOwn(current, path)) return current;
                                  const rest = { ...current };
                                  delete rest[path];
                                  return rest;
                                }
                                return Object.hasOwn(current, path) ? current : { ...current, [path]: true };
                              });
                            }}
                            onChange={(nextValue) => {
                              setNotice(null);
                              setDrafts((current) => {
                                const comparisonValue = Object.hasOwn(pendingConfigValues.current, path)
                                  ? pendingConfigValues.current[path]
                                  : storedValue;
                                if (valuesEqual(nextValue, comparisonValue)) {
                                  const rest = { ...current };
                                  delete rest[path];
                                  return rest;
                                }
                                return { ...current, [path]: nextValue };
                              });
                            }}
                          />
                        );
                      })}
                      {visibleFields.length === 0 && (
                        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">No Hermes settings match that search.</div>
                      )}
                    </div>
                  </ScrollArea>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-background/95 px-4 py-3 sm:px-5">
                    <div aria-live="polite" className="text-xs">
                      {error ? <span className="text-destructive">{error}</span>
                        : notice ? <span className="flex items-center gap-1 text-forest"><CheckCircle2Icon className="size-3" />{notice}{draftCount > 0 && ` · ${draftCount} newer unsaved ${draftCount === 1 ? "change" : "changes"}`}</span>
                          : invalidFieldCount > 0 ? <span className="text-destructive">Fix {invalidFieldCount} invalid {invalidFieldCount === 1 ? "setting" : "settings"} before saving.</span>
                          : <span className="text-muted-foreground">{draftCount} unsaved {draftCount === 1 ? "change" : "changes"}</span>}
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" disabled={saving || (draftCount === 0 && invalidFieldCount === 0)} onClick={() => {
                        setDrafts({});
                        setInvalidFields({});
                        setFieldTexts({});
                      }}>Discard</Button>
                      <Button size="sm" disabled={saving || draftCount === 0 || invalidFieldCount > 0} aria-label="Save Hermes settings" onClick={() => void save()}>
                        {saving && <LoaderCircleIcon className="size-3.5 animate-spin" />} Save changes
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="credentials" className="min-h-0">
              <div className="flex h-full min-h-0 flex-col">
                <div className="border-b border-border/60 px-4 py-3 sm:px-6">
                  <div className="flex items-start gap-3 rounded-xl border border-forest/20 bg-forest/5 p-3">
                    <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-forest" />
                    <div>
                      <p className="text-sm font-medium">Secrets stay write-only</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">Hermes returns only connection state and redacted previews. Channel credentials remain in their dedicated channel setup.</p>
                    </div>
                  </div>
                  <div className="relative mt-3">
                    <SearchIcon className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
                    <Input type="search" aria-label="Search Hermes credentials" placeholder="Search providers and credentials…" className="pl-9" value={credentialSearch} onChange={(event) => setCredentialSearch(event.target.value)} />
                  </div>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="grid gap-3 p-4 pb-8 sm:grid-cols-2 sm:p-6">
                    {visibleCredentials.map(([key, entry]) => (
                      <CredentialRow
                        key={key}
                        envKey={key}
                        entry={entry}
                        onCommitted={(isSet) => commitEnvironmentMutation(key, isSet)}
                      />
                    ))}
                    {visibleCredentials.length === 0 && (
                      <div className="col-span-full rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">No credentials match that search.</div>
                    )}
                  </div>
                </ScrollArea>
              </div>
            </TabsContent>
          </Tabs>
        ) : null}
        {confirmation && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 p-6">
            <div
              role="alertdialog"
              aria-modal="true"
              aria-label={confirmation === "refresh" ? "Confirm refresh" : "Confirm close"}
              className="w-full max-w-sm rounded-xl border bg-background p-5 shadow-xl"
            >
              <h3 className="text-sm font-semibold">
                {confirmation === "refresh"
                  ? "Discard unsaved changes and refresh?"
                  : "Discard unsaved changes and close?"}
              </h3>
              <p className="mt-2 text-xs text-muted-foreground">Your unsaved Hermes setting changes will be lost.</p>
              <div className="mt-4 flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => setConfirmation(null)}>Cancel</Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    const action = confirmation;
                    setConfirmation(null);
                    if (action === "refresh") {
                      void loadData(true, "refresh");
                    } else {
                      setDrafts({});
                      setInvalidFields({});
                      setFieldTexts({});
                      onOpenChange(false);
                    }
                  }}
                >
                  {confirmation === "refresh" ? "Discard and refresh" : "Discard and close"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
