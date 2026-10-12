const denied = () => new Error('App AI response unavailable');
export class HermesAppUndrainedError extends Error { constructor() { super('App AI transport unavailable'); } }
// Cancelling a live Web Stream closes it before the source's cancel hook:
// closed resolves even if that hook later rejects. Only a rejected closed
// promise proves an already-terminal stream error.
function terminalStreamError(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<boolean> {
  return reader.closed.then(() => false, error => {
    console.warn('[app-ai] response stream ended',error instanceof Error?error.name:'UnknownError');
    return true;
  });
}
export async function discardFailureBody(response: Response): Promise<void> {
  if (!response.body) return;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); }
  catch(error){console.warn('[app-ai] failed response reader unavailable',error instanceof Error?error.name:'UnknownError');throw new HermesAppUndrainedError();}
  const errored = terminalStreamError(reader);
  try {
    try { await reader.cancel(); }
    catch(error){
      if (!await errored) {
        console.warn('[app-ai] failed response drain unavailable',error instanceof Error?error.name:'UnknownError');
        throw new HermesAppUndrainedError();
      }
    }
  } finally { reader.releaseLock(); }
}
export async function boundedBody(response: Response, signal: AbortSignal, maxBytes = 256000, maxChunks = 16384): Promise<string> {
  if (!response.body) throw denied();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0; let chunksRead = 0;
  const errored = terminalStreamError(reader);
  let cancellation:Promise<void>|undefined; let cancellationFailed=false;let terminalReadFailure=false;
  const cancel=()=>cancellation ??= reader.cancel().then(()=>{},async error=>{cancellationFailed=!await errored;if(cancellationFailed)console.warn('[app-ai] response cancellation failed',error instanceof Error?error.name:'UnknownError');});
  const abort=()=>{void cancel();};
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();let next:ReadableStreamReadResult<Uint8Array>;
      try{next=await reader.read();}catch(error){terminalReadFailure=true;throw error;}
      if(next.done)break;
      size += next.value.byteLength; chunksRead++;
      if (size > maxBytes || chunksRead > maxChunks) throw denied();
      if(next.value.byteLength)chunks.push(next.value);
    }
    signal.throwIfAborted(); return Buffer.concat(chunks).toString('utf8');
  } catch(error){
    // A rejected read is already terminal. Cancelling an errored Web Stream
    // rejects its stored error; that is not an uncertain readable transport.
    if(!terminalReadFailure)await cancel();throw error;
  }
  finally {
    signal.removeEventListener('abort', abort); await cancellation;reader.releaseLock();
    if(cancellationFailed)throw new HermesAppUndrainedError();
  }
}
