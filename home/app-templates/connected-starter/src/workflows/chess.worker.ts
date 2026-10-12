import { analyzeCompletedGame } from "./chess-engine";
// One selected finished game per worker. The parent owns timeout, cancellation,
// and termination; no fetched code, network calls, or long-lived cache.
self.onmessage = (event: MessageEvent<{ pgn: string; status: string }>) => {
  try {
    const analysis = analyzeCompletedGame(event.data.pgn, event.data.status);
    self.postMessage({ ok: true, analysis });
  } catch (error) {
    console.warn("Local completed-game analysis failed", error instanceof Error ? error.name : "UnknownError");
    self.postMessage({ ok: false });
  }
};
