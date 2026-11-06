import { ChatGptPlanPeerCapabilitiesSchema, ChatGptPlanPeerPollV2Schema } from '@matrix-os/contracts';
import { logPlanFailure, PlanFailure } from './diagnostics';

const preconnectChrome = new Set(['ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED']);
const preconnectNode = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
/** Classify a bounded cause chain without retaining any raw error text. */
export function blocksPollDeliveryRecovery(error: unknown): boolean {
  try {
    let cause = error && typeof error === 'object' ? Reflect.get(error, 'cause') as unknown : undefined;
    for (let depth = 0; depth < 4 && cause !== undefined && cause !== null; depth++) {
      if (typeof cause !== 'object') return true;
      const code: unknown = Reflect.get(cause, 'code');
      if (typeof code !== 'string' || !preconnectNode.has(code)) return true;
      cause = Reflect.get(cause, 'cause') as unknown;
    }
    return cause !== undefined && cause !== null;
  } catch (error: unknown) {
    logPlanFailure('peer_poll', new PlanFailure('peer_poll', 'transport_error'));
    return true;
  }
}
export function retryableDeliveryFailure(error: unknown, stage: 'peer_poll' | 'peer_reply') {
  if (!(error instanceof PlanFailure) || error.stage !== stage) return false;
  // Only receipt-enabled callers use this classifier. A 502 is not a validated
  // receipt; retry the same ACK/chunk within the existing budget without
  // trusting its body or any ambiguous failure cause.
  if (error.category === 'http_error') return error.httpStatus === 502
    && error.networkDiagnostic === undefined && error.responseDiagnostic === undefined && error.cause === undefined;
  const diagnostic = error.networkDiagnostic;
  if (!diagnostic || !['before_headers', 'body_read'].includes(diagnostic.phase ?? '')) return false;
  // post() attaches this phase only for its own deadline's exact exception.
  // Keep unknown/certificate causes ineligible, including coincident failures.
  if (error.category === 'timeout') return diagnostic.code === undefined
    && diagnostic.causeCode === undefined && diagnostic.chromiumCode === undefined;
  if (error.category !== 'network_error') return false;
  // Certificate/trust/unknown causes win over generic SSL matching.
  for (const code of [diagnostic.code, diagnostic.causeCode]) if (code !== undefined && !preconnectNode.has(code)) return false;
  if (diagnostic.chromiumCode !== undefined) return diagnostic.chromiumCode === 'ERR_SSL_PROTOCOL_ERROR'
    || preconnectChrome.has(diagnostic.chromiumCode);
  return preconnectNode.has(diagnostic.code ?? diagnostic.causeCode ?? '');
}

/** Same signed session, constant-size receipt cursor, one consecutive retry. */
export function createNativePollDelivery(deps: {
  sessionId: string; signal: AbortSignal; current(): boolean;
  post(path: string, body: unknown, signal: AbortSignal, limit?: number): Promise<unknown>;
}) {
  let handled = 0, failures = 0;
  let approvedRoutines = false;
  const verify = () => {
    deps.signal.throwIfAborted();
    if (!deps.current()) throw new PlanFailure('peer_poll', 'stale_source');
  };
  return {
    async negotiate() {
      verify();
      const capability = ChatGptPlanPeerCapabilitiesSchema.safeParse(await deps.post('capabilities', { version: 1,
        sessionId: deps.sessionId }, deps.signal, 512));
      verify();
      if (!capability.success || capability.data.sessionId !== deps.sessionId) throw new PlanFailure('peer_capabilities', 'invalid_schema');
      approvedRoutines = capability.data.approvedRoutines === true;
      return capability.data.replyDeliveryVersion === 2;
    },
    supportsApprovedRoutines: () => approvedRoutines,
    async poll() {
      while (true) {
        verify();
        const attempt = new AbortController();
        try {
          const input = { version: 2, sessionId: deps.sessionId, ackThrough: handled };
          const batch = ChatGptPlanPeerPollV2Schema.safeParse(await deps.post('poll-v2', input,
            AbortSignal.any([deps.signal, attempt.signal])));
          verify();
          if (!batch.success || batch.data.sessionId !== deps.sessionId || batch.data.acknowledgedThrough !== handled) {
            throw new PlanFailure('peer_poll', 'invalid_schema');
          }
          failures = 0;
          const requests = batch.data.deliveries.map(entry => entry.request);
          const canceled = new Set(requests.filter(request => request.action === 'cancel').map(request => request.id)); // <=32.
          let index = 0;
          return { requests, canceled, receipt() {
            verify();
            const next = batch.data.deliveries[index++];
            if (!next || next.deliverySequence !== handled + 1) throw new PlanFailure('peer_poll', 'invalid_schema');
            handled = next.deliverySequence;
          } };
        } catch (error: unknown) {
          attempt.abort(); verify();
          if (failures !== 0 || !retryableDeliveryFailure(error, 'peer_poll')) throw error;
          failures = 1; logPlanFailure('peer_poll', error);
        } finally { attempt.abort(); }
      }
    },
  };
}
