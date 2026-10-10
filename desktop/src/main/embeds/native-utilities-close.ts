import { randomUUID } from "node:crypto";
import { UTILITIES_CLOSE_REQUEST, type UtilitiesCloseRequest } from "../../shared/native-utilities-close";

const TIMEOUT_MS = 60_000;
const MAX_PENDING = 12;
interface CloseDecision { allow: boolean; available: boolean }
interface PendingClose { requestId: string; promise: Promise<CloseDecision>; finish(allow: boolean, available?: boolean): void }

/** At most one bounded, document-scoped request per native Utilities view. */
export class NativeUtilitiesCloseGuard {
  private readonly pending = new Map<number, PendingClose>();
  private readonly confirmations = new Map<number, Promise<boolean>>();

  request(senderId: number, signal: AbortSignal, send: (channel: string, request: UtilitiesCloseRequest) => void): Promise<CloseDecision> {
    const existing = this.pending.get(senderId);
    if (existing) return existing.promise;
    if (signal.aborted || this.pending.size >= MAX_PENDING) return Promise.resolve({ allow: false, available: false });
    const requestId = randomUUID();
    let resolve!: (decision: CloseDecision) => void;
    const promise = new Promise<CloseDecision>(done => { resolve = done; });
    const safeSend = (type: UtilitiesCloseRequest["type"]) => {
      try { send(UTILITIES_CLOSE_REQUEST, { requestId, type }); }
      catch (error: unknown) { console.warn("[utilities-close] delivery failed", error instanceof Error ? "Error" : "UnknownError"); return false; }
      return true;
    };
    const abort = () => finish(false, false);
    const timer = setTimeout(() => finish(false, false), TIMEOUT_MS);
    const finish = (allow: boolean, available = true) => {
      if (this.pending.get(senderId)?.requestId !== requestId) return;
      this.pending.delete(senderId); clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (!allow) safeSend("cancel");
      resolve({ allow, available });
    };
    this.pending.set(senderId, { requestId, promise, finish });
    signal.addEventListener("abort", abort, { once: true });
    if (!safeSend("request")) finish(false, false);
    return promise;
  }

  reply(senderId: number, requestId: string, allow: boolean): void {
    const pending = this.pending.get(senderId);
    if (!pending || pending.requestId !== requestId) throw new Error("Close request is unavailable");
    pending.finish(allow);
  }

  confirm(senderId: number, signal: AbortSignal, show: (scope: AbortSignal) => Promise<boolean>): Promise<boolean> {
    const existing = this.confirmations.get(senderId);
    if (existing) return existing;
    if (signal.aborted || this.confirmations.size >= MAX_PENDING) return Promise.resolve(false);
    const controller = new AbortController();
    let resolve!: (allow: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    const abort = () => { controller.abort(); finish(false); };
    const timer = setTimeout(abort, TIMEOUT_MS);
    const finish = (allow: boolean) => {
      if (this.confirmations.get(senderId) !== promise) return;
      this.confirmations.delete(senderId); clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(allow);
    };
    this.confirmations.set(senderId, promise); signal.addEventListener("abort", abort, { once: true });
    try { void show(controller.signal).then(finish, (error: unknown) => {
      console.warn("[utilities-close] confirmation unavailable", error instanceof Error ? "Error" : "UnknownError"); finish(false);
    }); } catch (error: unknown) { console.warn("[utilities-close] confirmation unavailable", error instanceof Error ? "Error" : "UnknownError"); finish(false); }
    return promise;
  }
}
