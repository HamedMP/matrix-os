import { useCallback, useEffect, useRef, type RefObject } from "react";
import { canonicalChatInputs, type CanonicalChatDetailResponse, type CanonicalSubmitChatInputRequest } from "@matrix-os/contracts";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import { canonicalChatRequestId } from "./canonical-chat-submission";

type Scope = { active: boolean; client: CanonicalChatClient; projectId: string | null };
export function useCanonicalInputSubmission({ client, detailRef, scopeRef, loadDetail, setError }: {
  client: CanonicalChatClient;
  detailRef: RefObject<CanonicalChatDetailResponse | null>;
  scopeRef: RefObject<Scope | null>;
  loadDetail: (chatId: string, options?: { background?: boolean }) => Promise<CanonicalChatDetailResponse | null>;
  setError: (error: string | null) => void;
}) {
  // No answers retained; bounded retry keys live only for this mounted client.
  const keys = useRef(new Map<string, string>());
  const inFlight = useRef(new Set<string>());
  useEffect(() => { keys.current.clear(); inFlight.current.clear(); }, [client]);
  return useCallback(async (runId: string, requestId: string, answer: Omit<CanonicalSubmitChatInputRequest, "clientRequestId">) => {
    const detail = detailRef.current;
    const scope = scopeRef.current;
    if (!detail || !scope?.active || detail.record.activeRun?.runId !== runId) return false;
    const chatId = detail.record.chat.id;
    const identity = `${chatId}\0${runId}\0${requestId}`;
    if (inFlight.current.has(identity) || inFlight.current.size >= 8) return false;
    if (!canonicalChatInputs(detail).some(input => input.runId === runId && input.requestId === requestId && input.pending)) return false;
    let key = keys.current.get(identity);
    if (!key) {
      key = canonicalChatRequestId();
      if (keys.current.size >= 32) keys.current.delete(keys.current.keys().next().value!);
      keys.current.set(identity, key);
    }
    const current = () => scopeRef.current === scope && scope.active && detailRef.current?.record.chat.id === chatId;
    inFlight.current.add(identity);
    try {
      await client.submitInput(chatId, runId, requestId, { ...answer, clientRequestId: key });
      if (current()) { setError(null); await loadDetail(chatId, { background: true }); }
      return true;
    } catch (error: unknown) {
      console.warn("[canonical-chat] Input submission failed:", error instanceof Error ? error.name : "UnknownError");
      if (current()) {
        setError("The answer could not be submitted. Try again.");
        await loadDetail(chatId, { background: true });
      }
      return false;
    } finally { inFlight.current.delete(identity); }
  }, [client, detailRef, scopeRef, loadDetail, setError]);
}
