export class PreviewPairOperationTimeout extends Error {
  constructor() { super("Preview pair is unavailable"); this.name = "PreviewPairOperationTimeout"; }
}

/** Every external adapter also passes this signal to its actual network client. */
export async function previewPairOperation<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(controller.signal), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new PreviewPairOperationTimeout()); }, 10_000);
      timer.unref?.();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
