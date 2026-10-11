import React, { Suspense, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import { desktopPalette as palette, desktopFonts } from "@matrix-os/brand";
import { utilityCategories as categories, utilityCatalog as tools } from "./catalog-adapter";
import { filterTools, initialNavigation, MAX_SEARCH_LENGTH, navigationReducer, needsModelDownload, processingNotice, type UtilityTool } from "./utilities-model";
import { availableToolCount, toolAvailability } from "./tool-availability";
import { WorkspaceBoundary } from "./WorkspaceBoundary";
import { WorkspaceRouter } from "./WorkspaceRouter";
import { useWorkspaceCloseGuard } from "./useWorkspaceCloseGuard";
import { UtilityIcon } from "./UtilityIcon";

export default function App() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [navigation, dispatch] = useReducer(navigationReducer, initialNavigation);
  useWorkspaceCloseGuard(navigation.dirty);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const catalog = tools as UtilityTool[];
  const active = catalog.find((tool) => tool.slug === navigation.active);
  const results = useMemo(() => filterTools(catalog, search, category), [catalog, search, category]);
  const grouped = categories.map((name: string) => ({ name, tools: results.filter((tool) => tool.category === name) })).filter((group: { tools: UtilityTool[] }) => group.tools.length);
  const theme = {
    "--utilities-paper": palette.paper, "--utilities-canvas": palette.canvas,
    "--utilities-ink": palette.forest, "--utilities-muted": palette.textMuted,
    "--utilities-gold": palette.gold, "--utilities-folder-front": palette.blue,
    fontFamily: desktopFonts.sans,
  } as CSSProperties;

  useEffect(() => {
    if (navigation.pending !== undefined && !dialog.current?.open) dialog.current?.showModal();
    else if (navigation.pending === undefined && dialog.current?.open) dialog.current.close();
  }, [navigation.pending]);
  useEffect(() => {
    if (navigation.active) heading.current?.focus();
    else searchInput.current?.focus();
  }, [navigation.active]);
  useEffect(() => {
    if (!navigation.dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [navigation.dirty]);
  const back = () => dispatch({ type: "open", slug: null });
  const cancel = () => { dispatch({ type: "cancel" }); backButton.current?.focus(); };
  const captureEdit = (event: React.SyntheticEvent) => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest("input,textarea,select,[contenteditable='true']");
    if (!control) return;
    if (control instanceof HTMLInputElement && (control.disabled || control.readOnly ||
      ["button", "submit", "reset"].includes(control.type) || control.type === "file" && !control.files?.length)) return;
    if (control instanceof HTMLTextAreaElement && (control.disabled || control.readOnly)) return;
    if (control instanceof HTMLSelectElement && control.disabled) return;
    dispatch({ type: "dirty" });
  };
  const captureAction = (event: React.MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest('button[data-utilities-dirty="true"]') : null;
    if (button instanceof HTMLButtonElement && !button.disabled) dispatch({ type: "dirty" });
  };

  return <div className="utilities-app" style={theme}>
    <header className="utilities-topbar"><div className="utilities-brand"><UtilityIcon slug="utilities" small/><span>Utilities</span></div><span className="utilities-topbar-note">Your everyday toolkit</span></header>
    {active ? <main className="utilities-workspace">
      <button ref={backButton} className="utilities-back" onClick={back}>← All utilities</button>
      <header className="utilities-workspace-heading"><span className="utilities-eyebrow">{active.category}</span><h1 ref={heading} tabIndex={-1}>{active.title}</h1><p>{active.description}</p></header>
      {toolAvailability(active).available && <p className="utilities-notice">{processingNotice(active)}</p>}
      <div className="utilities-tool" onInputCapture={captureEdit} onChangeCapture={captureEdit} onClickCapture={captureAction} onDropCapture={(event) => { if (event.dataTransfer.files.length) dispatch({ type: "dirty" }); }}>
        <WorkspaceBoundary key={active.slug} onBack={back}><Suspense fallback={<p className="utilities-feedback" role="status">Opening {active.title}…</p>}><WorkspaceRouter tool={active}/></Suspense></WorkspaceBoundary>
      </div>
      <details className="utilities-help"><summary>How to use this tool and its limits</summary><p>{active.howTo}</p><p>{active.limitations}</p></details>
    </main> : <main className="utilities-catalog">
      <header className="utilities-intro"><h1>Your everyday toolkit</h1><p>{availableToolCount(catalog)} tools ready in Matrix, with {catalog.length - availableToolCount(catalog)} more available on the website. Find a task, open a workspace, and save the result.</p></header>
      <div className="utilities-search"><label htmlFor="utility-search">Search utilities</label><div><input ref={searchInput} id="utility-search" type="search" placeholder="Search tools, like PDF, word count, or QR…" maxLength={MAX_SEARCH_LENGTH} value={search} onChange={(event) => setSearch(event.target.value)}/>{search && <button onClick={() => { setSearch(""); searchInput.current?.focus(); }} aria-label="Clear search">×</button>}</div></div>
      <nav className="utilities-categories" aria-label="Tool categories">{["All", ...categories].map((name: string) => <button key={name} aria-pressed={category === name} onClick={() => setCategory(name)}>{name}</button>)}</nav>
      <p className="utilities-result-count" role="status">{results.length} {results.length === 1 ? "tool" : "tools"}{category !== "All" ? ` in ${category}` : ""}{search ? " matching your search" : " available"}</p>
      {grouped.map((group: { name: string; tools: UtilityTool[] }) => <section className="utilities-group" key={group.name} aria-labelledby={`category-${group.name}`}><h2 id={`category-${group.name}`}>{group.name}<span>{group.tools.length}</span></h2><div className="utilities-grid">{group.tools.map((tool) => <button className="utilities-card" key={tool.slug} onClick={() => dispatch({ type: "open", slug: tool.slug })}><UtilityIcon slug={tool.slug}/><span className="utilities-card-copy"><strong>{tool.title}</strong><span>{tool.description}</span><small>{!toolAvailability(tool).available ? "Website workspace" : tool.mode === "collaboration" ? "Peer connection" : needsModelDownload(tool) ? "Device processing · Downloads" : "Device processing"}</small></span></button>)}</div></section>)}
      {!results.length && <div className="utilities-feedback"><UtilityIcon slug="utilities"/><h2>No utilities found</h2><p>Try a shorter search or browse all categories.</p><button onClick={() => { setSearch(""); setCategory("All"); searchInput.current?.focus(); }}>Show all utilities</button></div>}
      <footer className="utilities-footer">Open files from this device and download your results. Model downloads and peer connections are identified in each workspace.</footer>
    </main>}
    <dialog ref={dialog} className="utilities-dialog" aria-labelledby="discard-title" onCancel={(event) => { event.preventDefault(); cancel(); }}><h2 id="discard-title">Leave this workspace?</h2><p>Your input and results here are temporary. Download or copy anything you need before leaving.</p><div><button autoFocus onClick={cancel}>Keep working</button><button className="utilities-discard" onClick={() => dispatch({ type: "discard" })}>Leave workspace</button></div></dialog>
  </div>;
}
