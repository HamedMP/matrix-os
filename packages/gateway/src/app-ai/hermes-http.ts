import { z } from 'zod/v4';
import { AppAiResultSchema, ChatGptPlanWireSchema } from '@matrix-os/contracts';
import { assertChatGptPlanCompleted } from '../bots/chatgpt-plan-wire.js';
import { HERMES_APP_ENDPOINTS, type proveHermesAppCredential } from './hermes-credential-proof.js';
const Message = z.object({ type: z.literal('message'), role: z.literal('assistant'), status: z.literal('completed'), content: z.array(z.object({ type: z.literal('output_text'), text: z.string().max(64000) })).max(128) });
const Output = z.array(z.union([Message, z.object({ type: z.literal('reasoning') })])).min(1).max(128);
const Responses = z.object({ model: z.string(), status: z.literal('completed'), output: Output });
const Anthropic = z.object({ model: z.string(), stop_reason: z.literal('end_turn'), content: z.array(z.object({ type: z.literal('text'), text: z.string().max(64000) })).max(128) });
const Chat = z.object({ model: z.string(), choices: z.array(z.object({ finish_reason: z.literal('stop'), message: z.object({ content: z.string().max(64000), tool_calls: z.array(z.never()).max(0).optional(), function_call: z.never().optional() }) })).length(1) });
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
async function discardFailureBody(response: Response): Promise<void> {
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
async function boundedBody(response: Response, signal: AbortSignal): Promise<string> {
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
      if (size > 256000 || chunksRead > 16384) throw denied();
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
function sseText(body: string, model: string): string {
  assertChatGptPlanCompleted(body, model); let text: string | undefined;
  for (const frame of body.replace(/\r\n/g, '\n').split('\n\n')) {
    const lines = frame.split('\n'); const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    const event = JSON.parse(data); const named = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    if (named && named !== event.type || event.item && !['message', 'reasoning'].includes(event.item.type) || /function_call|tool_call|web_search|file_search|computer_call/.test(event.type)) throw denied();
    if (event.type === 'response.completed') text = Output.parse(event.response.output).flatMap(item => item.type === 'message' ? item.content.map(part => part.text) : []).join('');
  }
  if (text === undefined) throw denied(); return text;
}
/** Fixed endpoints and literal text-only bodies. Credentials stay in trusted gateway headers. */
export async function completeHermesHttp(options: {
  proof: Awaited<ReturnType<typeof proveHermesAppCredential>>; prompt: string; signal: AbortSignal; fetchImpl?: typeof fetch;
}) {
  const { proof, signal } = options; signal.throwIfAborted();
  const system = 'Answer using only the supplied text. You have no tools or access to files.';
  const headers = new Headers({ 'content-type': 'application/json', accept: proof.provider === 'openai-codex' ? 'text/event-stream' : 'application/json' });
  if (proof.provider === 'anthropic') { headers.set('x-api-key', proof.key); headers.set('anthropic-version', '2023-06-01'); }
  else headers.set('authorization', `Bearer ${proof.key}`);
  if (proof.accountId) headers.set('chatgpt-account-id', proof.accountId);
  const body = proof.provider === 'anthropic' ? { model: proof.model, max_tokens: 8192, stream: false, system, messages: [{ role: 'user', content: options.prompt }] }
    : proof.provider === 'openrouter' ? { model: proof.model, max_tokens: 8192, stream: false, store: false, tools: [], tool_choice: 'none', messages: [{ role: 'system', content: system }, { role: 'user', content: options.prompt }] }
    : proof.provider === 'openai-codex' ? ChatGptPlanWireSchema.parse({ model: proof.model, stream: true, store: false, instructions: system, input: [{ role: 'user', content: options.prompt }] })
    : { model: proof.model, max_output_tokens: 8192, stream: false, store: false, tools: [], tool_choice: 'none', instructions: system, input: [{ role: 'user', content: options.prompt }] };
  const response = await (options.fetchImpl ?? fetch)(HERMES_APP_ENDPOINTS[proof.provider].url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal });
  if (!response.ok) {
    await discardFailureBody(response);
    throw denied();
  }
  const wire = await boundedBody(response, signal); let text: string;
  if (proof.provider === 'openai-codex') { if (!response.headers.get('content-type')?.startsWith('text/event-stream')) throw denied(); text = sseText(wire, proof.model); }
  else {
    const payload = JSON.parse(wire);
    if (payload.model !== proof.model) throw denied();
    text = proof.provider === 'anthropic' ? Anthropic.parse(payload).content.map(part => part.text).join('')
      : proof.provider === 'openrouter' ? Chat.parse(payload).choices[0]!.message.content
      : Responses.parse(payload).output.flatMap(item => item.type === 'message' ? item.content.map(part => part.text) : []).join('');
  }
  if(!text.trim())throw denied();
  return AppAiResultSchema.parse({ text });
}
