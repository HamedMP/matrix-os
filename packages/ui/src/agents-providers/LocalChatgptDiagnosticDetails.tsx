import { ChatgptPlanDiagnosticSchema, type ChatgptPlanDiagnostic } from "@matrix-os/contracts";
import type { LocalChatgptPlanClient } from "./local-chatgpt-plan-client.js";

function readCachedDiagnostic(client: LocalChatgptPlanClient): ChatgptPlanDiagnostic | null {
  try {
    const result = ChatgptPlanDiagnosticSchema.safeParse(client.getLastDiagnostic?.());
    return result.success ? result.data : null;
  } catch (caught) {
    console.warn("[chatgpt-plan] Cached diagnostic unavailable:", caught instanceof Error ? "invalid_cached_receipt" : "unknown");
    return null;
  }
}

/** No snapshot history: revalidate only the client's current, already-produced receipt. */
export function LocalChatgptDiagnosticDetails({ client }: { client: LocalChatgptPlanClient }) {
  const value = readCachedDiagnostic(client);
  return <section className="matrix-ap-help" aria-label="Connection details">
    <p>Details from the last connection check. Opening these details does not check the connection again.</p>
    {value ? <>
      <dl>
        <dt>Phase</dt><dd>{value.phase}</dd>
        <dt>Category</dt><dd>{value.category}</dd>
        <dt>Time</dt><dd>{value.at}</dd>
        <dt>Correlation ID</dt><dd>{value.correlationId}</dd>
      </dl>
      {value.httpStatus !== undefined ? <p>HTTP status: {value.httpStatus}</p> : null}
      {value.runtimeSlotMatches !== undefined ? <p>Runtime slot matches: {String(value.runtimeSlotMatches)}</p> : null}
      {value.authGenerationMatches !== undefined ? <p>Auth generation matches: {String(value.authGenerationMatches)}</p> : null}
      {value.ownerMatches !== undefined ? <p>Owner matches: {String(value.ownerMatches)}</p> : null}
    </> : <p>Diagnostic information is unavailable.</p>}
  </section>;
}
