/// <reference types="vite/client" />
import ChessWorker from "./chess.worker.ts?worker&inline";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OwnerRecord } from "../types";
import type { ViewProps } from "../views/common";
import { completedGame, boardSquares, isLegalVariation, type GameAnalysis, type SearchResult } from "./chess-engine";
import { correctedRecord } from "./models";
import { Intro, EmptyHint, RecordActions, SaveError, useSavedAction } from "./Shared";

function sourceSignature(pgn: string) { let hash = 14695981039346656037n; for (let index = 0; index < pgn.length; index++) hash = BigInt.asUintN(64, (hash ^ BigInt(pgn.charCodeAt(index))) * 1099511628211n); return hash.toString(16); }
function validSearch(search: SearchResult, fen: string) { return search && search.fen === fen && Number.isInteger(search.depth) && search.depth >= 0 && search.depth <= 3 && Number.isInteger(search.nodes) && search.nodes >= 0 && search.nodes <= 20000 && (search.whiteScore === null || (Number.isFinite(search.whiteScore) && Math.abs(search.whiteScore) <= 100000)) && isLegalVariation(fen, search.variation) && search.bestMove === (search.variation[0] ?? null); }
function validAnalysis(value: unknown, pgn: string): value is GameAnalysis {
  if (!value || typeof value !== "object" || !("positions" in value) || !("result" in value) || !("engine" in value) || typeof value.engine !== "string" || value.engine.length > 200 || !Array.isArray(value.positions) || value.positions.length > 6) return false;
  const game = completedGame(pgn, "Completed");
  return value.result === game.result && value.positions.every(item => {
    if (!item || typeof item !== "object" || !item.position) return false;
    const actual = game.positions.find(position => position.ply === item.position.ply);
    return Boolean(actual && actual.san === item.position.san && actual.before === item.position.before && actual.after === item.position.after && validSearch(item.before, actual.before) && validSearch(item.after, actual.after) && (item.loss === null || (Number.isFinite(item.loss) && item.loss >= 0 && item.loss <= 200000)));
  });
}
function savedAnalysis(record: OwnerRecord): GameAnalysis | null {
  if (typeof record.fields.analysis !== "string" || record.fields.analysis.length > 12000 || typeof record.fields.pgn !== "string") return null;
  try {
    const value = JSON.parse(record.fields.analysis);
    return value?.sourceSignature === sourceSignature(record.fields.pgn) && validAnalysis(value, record.fields.pgn) ? value : null;
  } catch (error) { if (!(error instanceof Error)) throw error; return null; }
}
const pieces: Record<string, string> = { wk: "♔", wq: "♕", wr: "♖", wb: "♗", wn: "♘", wp: "♙", bk: "♚", bq: "♛", br: "♜", bb: "♝", bn: "♞", bp: "♟" };
const pieceNames: Record<string, string> = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
function scoreText(value: number | null) { if (value === null) return "No complete search depth"; return Math.abs(value) > 90000 ? `${value > 0 ? "White" : "Black"} has a searched mate line` : `${value >= 0 ? "+" : ""}${(value / 100).toFixed(2)} pawns for White`; }
export default function ChessCoach(props: ViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null), [ply, setPly] = useState(0), [analysis, setAnalysis] = useState<{ id: string; signature: string; value: GameAnalysis } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [reveal, setReveal] = useState(false), [idea, setIdea] = useState(""), [feedback, setFeedback] = useState("");
  const active = useRef<{ worker: Worker; timer: ReturnType<typeof setTimeout> } | null>(null), saved = useSavedAction(props.onSave);
  const record = props.records.find(item => item.id === selectedId) ?? props.records[0];
  const pgn = typeof record?.fields.pgn === "string" ? record.fields.pgn : "";
  const parsed = useMemo(() => { if (!record) return { game: null, error: "" }; try { return { game: completedGame(pgn, record.fields.status), error: "" }; } catch (cause) { return { game: null, error: cause instanceof Error && cause.message.length < 200 ? cause.message : "Review a valid completed PGN." }; } }, [record?.id, pgn, record?.fields.status]);
  function cancel() { if (active.current) { clearTimeout(active.current.timer); active.current.worker.terminate(); active.current = null; } }
  useEffect(() => { cancel(); setBusy(false); setError(""); setPly(0); setReveal(false); setIdea(""); setFeedback(""); return cancel; }, [record?.id, pgn]);
  const currentAnalysis = record && analysis?.id === record.id && analysis.signature === sourceSignature(pgn) ? analysis.value : record ? savedAnalysis(record) : null;
  const reviewed = currentAnalysis?.positions[ply] ?? currentAnalysis?.positions[0];
  const position = reviewed?.position ?? parsed.game?.positions[Math.min(ply, (parsed.game?.positions.length ?? 1) - 1)];
  const fen = position?.before ?? parsed.game?.finalFen;
  const squares = fen ? boardSquares(fen) : [];
  const oriented = record?.fields.perspective === "Black" ? [...squares].reverse() : squares;
  function analyze() {
    if (!record || !parsed.game || !pgn || busy) return;
    cancel(); setError(""); setBusy(true); setReveal(false);
    try {
      // Installed apps use an opaque-origin srcDoc sandbox. The built worker
      // carries its engine in a local Blob instead of requesting an app asset.
      const worker = new ChessWorker();
      const timer = setTimeout(() => { if (active.current?.worker === worker) { cancel(); setBusy(false); setError("Local search reached its time limit. Your game is unchanged; try again."); } }, 8000);
      active.current = { worker, timer };
      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (active.current?.worker !== worker) return;
        cancel(); setBusy(false);
        const payload = event.data as { ok?: unknown; analysis?: unknown };
        if (payload?.ok === true && validAnalysis(payload.analysis, pgn)) { setAnalysis({ id: record.id, signature: sourceSignature(pgn), value: payload.analysis }); setPly(0); }
        else setError("The local search could not produce a valid review. Your game is unchanged.");
      };
      worker.onerror = () => { if (active.current?.worker === worker) { cancel(); setBusy(false); setError("The local chess worker could not run. Keep the PGN and retry in Matrix."); } };
      worker.postMessage({ pgn, status: "Completed" });
    } catch (cause) { cancel(); setBusy(false); console.warn("Chess worker startup failed", cause instanceof Error ? cause.name : "UnknownError"); setError("Local analysis is unavailable in this runtime. The saved game remains available."); }
  }
  function reviewIdea() {
    if (!reviewed) return;
    if (!isLegalVariation(reviewed.before.fen, [idea.trim()])) { setFeedback("That SAN move is not legal in this position. Try another move."); return; }
    setFeedback(idea.trim() === reviewed.before.bestMove ? "Your idea matches the best move found at this completed search depth." : "Your idea is legal. Reveal the bounded search line to compare it.");
  }
  return <div className="new-workflow nw-chess"><Intro title="Learn from the game after it ends." detail="Paste a finished PGN. Legal moves are verified locally, then a bounded local engine searches a few positions for review." action={<button className="primary" onClick={props.onAdd}>Add completed game</button>} />
    {!record ? <EmptyHint>Add a completed PGN ending in 1-0, 0-1 or 1/2-1/2. Ongoing games and live move assistance are excluded.</EmptyHint> : <><div className="nw-chess-toolbar"><label>Saved game<select value={record.id} onChange={event => setSelectedId(event.target.value)}>{props.records.slice(0, 1000).map(item => <option key={item.id} value={item.id}>{String(item.fields.title ?? "Game")}</option>)}</select></label><button onClick={analyze} disabled={!parsed.game || busy}>{busy ? "Searching locally…" : "Analyze completed game"}</button>{busy && <button onClick={() => { cancel(); setBusy(false); setError("Search cancelled. Your game is unchanged."); }}>Cancel search</button>}<RecordActions record={record} {...props} /></div><SaveError error={parsed.error || error || saved.error} />
    {parsed.game && <div className="nw-chess-layout"><section><div className="nw-chessboard" role="img" aria-label={`Saved completed game, position before move ${position?.ply ?? "end"}. ${record.fields.perspective === "Black" ? "Black" : "White"} at the bottom.`}>{oriented.map(square => <span key={square.square} className={(square.square.charCodeAt(0) + Number(square.square[1])) % 2 ? "light" : "dark"} title={`${square.square}: ${square.piece ? `${square.piece[0] === "w" ? "White" : "Black"} ${pieceNames[square.piece[1]]}` : "empty"}`} aria-label={square.square}>{square.piece ? pieces[square.piece] : ""}<small>{square.square}</small></span>)}</div><label className="nw-position-picker">Position to review<select value={ply} onChange={event => { setPly(Number(event.target.value)); setReveal(false); setIdea(""); setFeedback(""); }}>{(currentAnalysis?.positions.map(item => item.position) ?? parsed.game.positions).map((item, index) => <option key={item.ply} value={index}>Ply {item.ply}: {item.san}</option>)}</select></label><p className="nw-footnote">Result: {parsed.game.result}. Board orientation follows your saved perspective; evaluations always use White’s perspective.</p></section>
    <aside className="nw-chess-review"><h3>Try before revealing</h3>{reviewed ? <><p>Before {reviewed.position.color === "w" ? "White" : "Black"} played {reviewed.position.san}, what would you consider?</p><label>Your SAN move<input value={idea} maxLength={16} onChange={event => setIdea(event.target.value)} placeholder="e.g. Qxf7#" /></label><button onClick={reviewIdea} disabled={!idea.trim()}>Check legal idea</button>{feedback && <p role="status">{feedback}</p>}<button className="primary" onClick={() => setReveal(true)}>Reveal local search</button>{reveal && <div className="nw-searched-line"><h4>{reviewed.before.bestMove ?? "No searched move"}</h4><p>{scoreText(reviewed.before.whiteScore)}</p><p>Legal searched line: {reviewed.before.variation.join(" ") || "No completed line"}</p><p>Depth {reviewed.before.depth} · {reviewed.before.nodes} nodes{reviewed.before.bounded ? " · Budget reached" : ""}</p><p>After the played move: {scoreText(reviewed.after.whiteScore)} · depth {reviewed.after.depth}</p>{reviewed.loss !== null && <p>Approximate search swing: {(reviewed.loss / 100).toFixed(2)} pawns. Search depths may differ; this is a study lead, not a blunder classification.</p>}</div>}</> : <p>Run local analysis to create a searched review. Saved moves alone never produce an invented score.</p>}{currentAnalysis && <><button disabled={saved.busy} onClick={() => void saved.save(correctedRecord(record, { analysis: JSON.stringify({ ...currentAnalysis, sourceSignature: sourceSignature(pgn) }) }))}>{saved.busy ? "Saving…" : "Save this local review"}</button><p className="nw-footnote">{currentAnalysis.engine}. At most depth 3, 20,000 nodes per position, six reviewed plies and five seconds of total search. It is a lightweight teaching search, without Stockfish or playing-strength claims.</p></>}</aside></div>}
    </>}
  </div>;
}
