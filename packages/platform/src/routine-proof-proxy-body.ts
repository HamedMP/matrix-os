type RoutineProofProxyBody = string | null | { status: 400 | 408 | 413 | 503 };
export type ReadRoutineProofProxyBody = () => Promise<RoutineProofProxyBody>;

export async function readRoutineProofProxyBody(request: Request, limit: number, timeoutMs = 5000): Promise<RoutineProofProxyBody> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    void reader?.cancel().catch((error: unknown) => console.warn("[routine-proof] Body cancellation unavailable", typeof error));
    void request.body?.cancel().catch((error: unknown) => console.warn("[routine-proof] Request cancellation unavailable", typeof error));
  };
  try {
    reader = request.clone().body?.getReader();
    if (!reader) return null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("RoutineProofBodyTimeout")), timeoutMs);
      timer.unref?.();
    });
    const buffer = Buffer.alloc(limit);
    let bytes = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) break;
      if (bytes + next.value.byteLength > limit) { cancel(); return { status: 413 }; }
      buffer.set(next.value, bytes);
      bytes += next.value.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
  } catch (error: unknown) {
    cancel();
    if (error instanceof Error && error.message === "RoutineProofBodyTimeout") return { status: 408 };
    console.warn("[routine-proof] Browser proof body unavailable", error instanceof Error ? error.name : "UnknownError");
    return { status: error instanceof TypeError ? 400 : 503 };
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}
