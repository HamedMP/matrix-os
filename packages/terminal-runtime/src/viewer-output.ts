type PendingOutput = {
  data: Uint8Array;
  resolve: () => void;
  reject: (error: unknown) => void;
};

// Serialize asynchronous transports without allowing a slow viewer to retain
// unlimited PTY output. Synchronous transports still send immediately.
export function createViewerOutput(sink: (data: Uint8Array) => void | Promise<void>) {
  const queue: PendingOutput[] = [];
  let active: PendingOutput | undefined;
  let pendingBytes = 0;
  let failure: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function fail(error: unknown) {
    failure ??= error instanceof Error ? error : new Error("Terminal output unavailable");
    clearTimeout(timer);
    timer = undefined;
    active?.reject(failure);
    active = undefined;
    for (const item of queue.splice(0)) item.reject(failure);
    pendingBytes = 0;
  }

  function pump() {
    if (active || failure) return;
    const item = queue.shift();
    if (!item) return;
    active = item;
    function complete() {
      if (active !== item) return;
      clearTimeout(timer);
      timer = undefined;
      active = undefined;
      pendingBytes -= item!.data.byteLength;
      item!.resolve();
      pump();
    }
    try {
      const result = sink(item.data);
      if (result) {
        if (active === item) {
          timer = setTimeout(() => fail(new Error("Terminal output timed out")), 5000);
          timer.unref();
        }
        void result.then(complete, fail);
      } else complete();
    } catch (error: unknown) { fail(error); }
  }

  const send = (data: Uint8Array): Promise<void> => {
    if (failure) return Promise.reject(failure);
    if (pendingBytes + data.byteLength > 1024 * 1024 || queue.length + Number(Boolean(active)) >= 256) {
      fail(new Error("Terminal output capacity exceeded"));
      return Promise.reject(failure);
    }
    pendingBytes += data.byteLength;
    return new Promise<void>((resolve, reject) => {
      queue.push({ data: data.slice(), resolve, reject });
      pump();
    });
  };
  send.dispose = () => fail(new Error("Terminal output closed"));
  return send;
}
