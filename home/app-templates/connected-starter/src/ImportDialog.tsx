import { useEffect, useMemo, useState } from "react";
import { importPrompt, uniqueConnection } from "./import";
import Sheet from "./Sheet";
import type { Connection, Definition } from "./types";
export function ImportDialog({
  app,
  onClose,
}: {
  app: Definition;
  onClose: () => void;
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
    [sent, setSent] = useState(false);
  const selectedKeys = useMemo(() => new Set(chosen), [chosen]);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        if (!window.MatrixOS?.integrations)
          throw new Error("Connections unavailable");
        const data = await window.MatrixOS.integrations();
        if (!Array.isArray(data) || data.length > 100)
          throw new Error("Invalid connections");
        if (alive)
          setInventory(
            data
              .filter(
                (c) =>
                  typeof c.service === "string" &&
                  typeof c.account_label === "string" &&
                  c.account_label.length <= 200 &&
                  c.status === "active",
              )
              .slice(0, 100),
          );
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
  function request() {
    try {
      if (!window.MatrixOS?.generate || inventory === null)
        throw new Error(
          "Import is unavailable. Check connections and try again.",
        );
      const accounts = inventory
        .filter((c) => selectedKeys.has(`${c.service}:${c.account_label}`))
        .map((c) => ({ service: c.service, label: c.account_label }));
      const prompt = importPrompt(
        app,
        { accounts, start, end, context, scope },
        inventory,
      );
      window.MatrixOS.generate(prompt);
      setSent(true);
      setError("");
    } catch (cause) {
      console.error("Import request failed", cause);
      setError(
        cause instanceof Error && /^Choose/.test(cause.message)
          ? cause.message
          : "Import could not be requested. Check your connections and try again.",
      );
    }
  }
  return (
    <Sheet title={`Connect ${app.name}`} onClose={onClose}>
      {sent ? (
        <div className="request-sent">
          <span className="orb">↗</span>
          <h3>Request sent to Matrix</h3>
          <p>
            Matrix will review your selected sources and save supported records.
            Return to this app and choose <strong>Check records</strong> to see
            what was added.
          </p>
          <p className="muted">No import has been confirmed yet.</p>
          <button className="primary" onClick={onClose}>
            Back to records
          </button>
        </div>
      ) : (
        <div className="editor">
          <p className="muted">
            Choose exactly which accounts Matrix can read. It will keep the
            original evidence and preserve your edits.
          </p>
          {!loaded ? (
            <p>Checking connections…</p>
          ) : inventory === null ? (
            <p className="notice">
              Connection availability could not be checked.
            </p>
          ) : (
            app.services.map((service) => {
              const accounts = inventory.filter(
                (c) => c.service === service.id,
              );
              return (
                <fieldset key={service.id}>
                  <legend>{service.name}</legend>
                  {accounts.length ? (
                    accounts
                      .filter(
                        (c, i) =>
                          accounts.findIndex(
                            (other) =>
                              other.service === c.service &&
                              other.account_label === c.account_label,
                          ) === i,
                      )
                      .map((account) => {
                        const key = `${account.service}:${account.account_label}`;
                        const ambiguous = !uniqueConnection(
                          inventory,
                          account.service,
                          account.account_label,
                        );
                        return (
                          <label className="check" key={key}>
                            <input
                              type="checkbox"
                              disabled={ambiguous}
                              checked={selectedKeys.has(key)}
                              onChange={(e) =>
                                setChosen(
                                  e.target.checked
                                    ? [...chosen, key]
                                    : chosen.filter((k) => k !== key),
                                )
                              }
                            />
                            <span>
                              {account.account_label}
                              <small>
                                {ambiguous
                                  ? "This label matches multiple accounts. Give each account a unique label in Matrix Settings."
                                  : (account.account_email ??
                                    "Connected account")}
                              </small>
                            </span>
                          </label>
                        );
                      })
                  ) : (
                    <p className="muted">
                      Connect this service in Matrix Settings first.
                    </p>
                  )}
                </fieldset>
              );
            })
          )}
          <div className="date-fields">
            <label>
              <span>From</span>
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              <span>Through</span>
              <input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
          <label>
            <span>Repository, project, channel or source context</span>
            <textarea
              value={context}
              rows={3}
              maxLength={2000}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Be specific about which sources to include"
            />
          </label>
          <label>
            <span>Imported record group</span>
            <select
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
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          <button
            className="primary"
            disabled={!loaded || inventory === null}
            onClick={request}
          >
            Ask Matrix to import
          </button>
        </div>
      )}
    </Sheet>
  );
}
