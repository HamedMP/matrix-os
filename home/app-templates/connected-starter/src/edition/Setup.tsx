import Dialog from "./Dialog";
import { useEffect, useState } from "react";
import { parseGalleryInventory } from "../generated-inventory";
import type { Connection } from "../types";
import type { EditionSource, MailBridge } from "./types";
export default function Setup({
  bridge,
  onClose,
  onConnected,
  existingSources = [],
}: {
  bridge: MailBridge;
  existingSources?: EditionSource[];
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const [connections, setConnections] = useState<Connection[] | null>(null),
    [connectionId, setConnectionId] = useState(""),
    [scope, setScope] = useState<"personal" | "work">("personal"),
    [historyMonths, setHistoryMonths] = useState(3),
    [shareWith, setShareWith] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    window.MatrixOS?.integrations?.()
      .then((raw) => {
        if (alive)
          setConnections(
            parseGalleryInventory(raw).filter(
              (c) =>
                c.service === "gmail" &&
                c.status === "active" &&
                c.id &&
                c.account_email,
            ),
          );
      })
      .catch((cause) => {
        console.warn("Edition connections unavailable");
        if (alive)
          setError("Your email connections could not be loaded. Try again.");
      });
    return () => {
      alive = false;
    };
  }, []);
  async function connect() {
    const selected = connections?.find((c) => c.id === connectionId);
    if (!selected?.id || !selected.account_email) return;
    setBusy(true);
    setError("");
    try {
      await bridge("connect", {
        connectionId: selected.id,
        expectedEmail: selected.account_email,
        scope,
        historyMonths,
        shareWith,
      });
      await onConnected();
      onClose();
    } catch (cause) {
      console.warn("Edition source connection failed");
      setError(
        "This account could not be added. Your existing reading library remains available.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog titleId="edition-setup-title" onClose={onClose}>
      <button
        className="edition-close"
        aria-label="Close email setup"
        onClick={onClose}
      >
        ×
      </button>
      <span className="edition-eyebrow">
        A little less inbox. A little more reading.
      </span>
      <h2 id="edition-setup-title">Make room for good ideas.</h2>
      <p>
        Choose the exact email account you want Edition to read. The first
        import covers your selected history range.
      </p>
      {error && <p role="alert">{error}</p>}
      <label>
        Email account
        <select
          value={connectionId}
          onChange={(e) => {
            setConnectionId(e.target.value);
            const existing = existingSources.find(
              (source) => source.connectionId === e.target.value,
            );
            setShareWith(existing?.sharedWith ?? []);
            setScope(existing?.scope ?? "personal");
          }}
        >
          <option value="">Choose an account</option>
          {connections?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.account_email} · {c.account_label}
            </option>
          ))}
        </select>
      </label>
      {connections?.length === 0 && (
        <p>
          No connected Gmail accounts are ready.{" "}
          <button
            onClick={() =>
              window.MatrixOS?.navigate?.("/settings/integrations")
            }
          >
            Connect email in Matrix
          </button>
        </p>
      )}
      <label>
        Keep this reading in
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as "personal" | "work")}
        >
          <option value="personal">Personal</option>
          <option value="work">Work</option>
        </select>
      </label>
      <label>
        Import email history
        <select
          aria-label="Import email history"
          value={historyMonths}
          onChange={(e) => setHistoryMonths(Number(e.target.value))}
        >
          {[1, 3, 6, 12, 24].map((months) => (
            <option key={months} value={months}>
              Last {months} {months === 1 ? "month" : "months"}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="edition-sharing">
        <legend>Let other apps reuse this saved history</legend>
        {[
          ["folio", "Folio · receipts and expenses"],
          ["atlas", "Atlas · trip bookings"],
        ].map(([id, label]) => (
          <label key={id}>
            <input
              type="checkbox"
              checked={shareWith.includes(id)}
              onChange={(e) =>
                setShareWith((items) =>
                  e.target.checked
                    ? [...items, id]
                    : items.filter((item) => item !== id),
                )
              }
            />
            {label}
          </label>
        ))}
        <small>
          Optional. Each app receives only its authorized email evidence. You
          can revoke sharing later.
        </small>
      </fieldset>
      <div className="edition-permission">
        <b>Saved on your Matrix computer</b>
        <p>
          Edition shares a retained email archive with apps you authorize.
          Reading never changes your source read labels. Inbox cleanup always
          starts with a separate review.
        </p>
      </div>
      <button
        className="edition-primary"
        disabled={busy || !connectionId}
        onClick={() => void connect()}
      >
        {busy
          ? "Adding your reading source…"
          : `Add account & import ${historyMonths} ${historyMonths === 1 ? "month" : "months"}`}
      </button>
      <small>
        You can export or remove retained emails at any time. No attachments are
        downloaded automatically.
      </small>
    </Dialog>
  );
}
