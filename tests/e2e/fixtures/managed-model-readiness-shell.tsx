import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanonicalProviderCatalogSchema, type CanonicalProviderCatalog } from "../../../packages/contracts/src/index";
import { ProviderModelPicker } from "../../../desktop/src/renderer/src/features/chat/ProviderModelPicker";
import { useCanonicalComposerSelection } from "../../../desktop/src/renderer/src/features/chat/use-canonical-composer-selection";
import { canonicalComposerSelectionIsAvailable } from "../../../packages/ui/src/canonical-composer-selection";
import { ChatPromptInput } from "../../../packages/ui/src/chat/composer/ChatPromptInput";
import "../../../desktop/src/renderer/src/design/index.css";

const EMPTY: CanonicalProviderCatalog = { revision: "loading", drivers: [], instances: [] };
function Fixture() {
  const [catalog, setCatalog] = useState(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("Keep this exact model for my next task.");
  const [sent, setSent] = useState(false);
  const { selection, onSelectionChange } = useCanonicalComposerSelection({ catalog, catalogReady: loaded, initializeImmediately: true, chatId: null });
  async function refresh() {
    const response = await fetch("/catalog", { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("Fixture catalog unavailable");
    setCatalog(CanonicalProviderCatalogSchema.parse(await response.json())); setLoaded(true);
  }
  useEffect(() => { void refresh().catch(error => console.error("Fixture catalog read failed", error)); }, []);
  const available = canonicalComposerSelectionIsAvailable(catalog, selection);
  return <main style={{ maxWidth: 820, margin: "64px auto", padding: 32 }}>
    <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Isolated Electron acceptance · production Chat controls</p>
    <h1 style={{ fontSize: 28, margin: "12px 0" }}>Choose your Matrix AI model</h1>
    <p style={{ color: "var(--text-secondary)", marginBottom: 32 }}>Model choice stays with this computer while execution readiness changes.</p>
    <ChatPromptInput value={draft} onChange={setDraft} busy={false} ariaLabel="Message chat" canSubmit={available && draft.trim().length > 0}
      onSubmit={() => setSent(true)} controls={<ProviderModelPicker catalog={catalog} selection={selection} instanceLocked={false}
        loading={!loaded} onChange={onSelectionChange} />} />
    <div style={{ marginTop: 24, color: "var(--text-secondary)", fontSize: 13 }}>
      <p role="status">{available ? "Selected model is ready to send" : "Selected execution is unavailable"}</p>
      <p>Catalog state: <span data-testid="catalog-state">{catalog.revision}</span></p>
      <button type="button" style={{ marginTop: 12, textDecoration: "underline" }} onClick={() => { void refresh(); }}>Refresh catalog observation</button>
      {sent ? <p>Local fixture send clicked</p> : null}
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
