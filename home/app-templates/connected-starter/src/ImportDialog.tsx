import { parseGalleryInventory } from "./generated-inventory";
import { useEffect, useMemo, useRef, useState } from "react";
import { importContextLabel, importPrompt } from "./import";
import Sheet from "./Sheet";
import ImportAccounts from "./ImportAccounts";
import SyncProgress from "./SyncProgress";
import { syncRequest } from "./useSync";
import { gallerySyncIntervalMs, type GallerySyncInput, type GallerySyncSnapshot } from "./generated-sync";
import type { Connection, Definition } from "./types";
export function ImportDialog({
  app,
  onClose,
  onStart,
  progress,
}: {
  app: Definition;
  onClose: () => void;
  onStart?: (input: GallerySyncInput) => Promise<GallerySyncSnapshot>;
  progress?: GallerySyncSnapshot | null;
}) {
  const [inventory, setInventory] = useState<Connection[] | null>(null),
    [loaded, setLoaded] = useState(false),
    [chosen, setChosen] = useState<string[]>([]),
    [start, setStart] = useState(() =>
      new Date(new Date().getFullYear(), 0, 1).toLocaleDateString("en-CA"),
    ),
    [end, setEnd] = useState(() => new Date().toLocaleDateString("en-CA")),
    [context, setContext] = useState(""),
    [scope, setScope] = useState<"personal" | "work">(
      app.collection === "business" ? "work" : "personal",
    ),
    [error, setError] = useState(""),
    [starting, setStarting] = useState(false),
    [keepUpdated, setKeepUpdated] = useState(true),
    [accepted, setAccepted] = useState<GallerySyncSnapshot | null>(() => progress && ["queued", "running"].includes(progress.status) ? progress : null);
  const submission = useRef<{ key: string; requestId: string } | null>(null);
  const selectedKeys = useMemo(() => new Set(chosen), [chosen]);
  const contextLabel = importContextLabel(chosen.map(key => key.split(":")[0]));
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        if (!window.MatrixOS?.integrations)
          throw new Error("Connections unavailable");
        const data = await window.MatrixOS.integrations();
        const parsed = parseGalleryInventory(data);
        if (alive) setInventory(parsed.filter((c) => c.status === "active"));
      } catch (cause) {
        console.error("Connection inventory failed", cause);
        if (alive) setInventory(null);
      } finally {
        if (alive) setLoaded(true);
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, []);
  async function request() {
    if (starting) return;
    try {
      if ((!onStart && !window.MatrixOS?.gatewayFetch) || inventory === null)
        throw new Error(
          "Import is unavailable. Check connections and try again.",
        );
      const accounts = inventory
        .filter((c) => selectedKeys.has(`${c.service}:${c.account_label}`))
        .map((c) => ({
          service: c.service,
          label: c.account_label,
          connectionId: c.id ?? "",
          expectedEmail: c.account_email ?? null,
        }));
      importPrompt(
        app,
        { accounts, start, end, context: contextLabel ? context : "", scope },
        inventory,
      );
      setStarting(true);
      const selected = { accounts, start, end, context: contextLabel ? context : "", scope, keepUpdated };
      const key = JSON.stringify(selected);
      if (submission.current?.key !== key) submission.current = { key, requestId: crypto.randomUUID() };
      const input = { ...selected, requestId: submission.current.requestId };
      const result = onStart ? await onStart(input) : await syncRequest(app.id, "start", input);
      if (!result) throw new Error("Sync unavailable");
      setAccepted(result);
      setError("");
    } catch (cause) {
      console.error("Import request failed", cause);
      setError(
        cause instanceof Error && /^Choose/.test(cause.message)
          ? cause.message
          : "Import could not be requested. Check your connections and try again.",
      );
    } finally { setStarting(false); }
  }
  return (
    <Sheet title={accepted ? `Importing ${app.name}` : `Connect ${app.name}`} onClose={onClose}>
      {accepted ? (
        <div className="import-progress">
          <SyncProgress name={app.name} snapshot={progress ?? accepted} />
          <button className="primary" onClick={onClose}>
            Continue using this app
          </button>
        </div>
      ) : (
        <div className="editor import-editor">
          <p className="muted">
            Select accounts and a date range to import. Your edits and source evidence are preserved.
          </p>
          <ImportAccounts app={app} inventory={inventory} loaded={loaded} chosen={chosen} onChoose={setChosen} disabled={starting} />
          <div className="date-fields">
            <label>
              <span>From</span>
              <input
                type="date"
                disabled={starting}
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              <span>Through</span>
              <input
                type="date"
                disabled={starting}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
          {contextLabel && <label>
            <span>{contextLabel}</span>
            <textarea
              value={context}
              disabled={starting}
              rows={2}
              maxLength={2000}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Be specific about which sources to include"
            />
          </label>}
          <label>
            <span>Imported record group</span>
            <select
              disabled={starting}
              value={scope}
              onChange={(e) => setScope(e.target.value as "personal" | "work")}
            >
              <option value="personal">Personal</option>
              <option value="work">Work</option>
            </select>
          </label>
          <p className="fine-print">
            Read-only access. Matrix will use supported actions only, leave
            unknown facts empty, and report incomplete coverage.
          </p>
          <label className="check">
            <input type="checkbox" checked={keepUpdated} disabled={starting} onChange={e => setKeepUpdated(e.target.checked)} />
            <span><strong>Keep this app updated</strong><small>Check selected accounts every {gallerySyncIntervalMs(chosen.map(key => ({ service: key.split(":")[0] }))) / 60_000 === 1 ? "minute" : "15 minutes"} while your Matrix computer is running. New records appear automatically. AI processing uses your Matrix AI allowance. You can pause anytime.</small></span>
          </label>
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          <button
            className="primary"
            disabled={starting || !loaded || inventory === null}
            onClick={() => void request()}
          >
            {starting ? "Starting import…" : "Start import"}
          </button>
        </div>
      )}
    </Sheet>
  );
}
