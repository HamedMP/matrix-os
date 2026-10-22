// Fixed stdio MCP bridge for a single official Claude Bot task. No provider credentials.
import { StringDecoder } from 'node:string_decoder';
const url = new URL(process.env.MATRIX_BOT_TASK_URL ?? '');
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Invalid task bridge');
const token = process.env.MATRIX_BOT_TASK_TOKEN;
if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid task bridge');
const send = async (action, payload) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...payload }), redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('Task action unavailable');
  if (!response.body) throw new Error('Task response unavailable');
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 240 * 1024) { await reader.cancel(); throw new Error('Task response too large'); } chunks.push(part.value); } } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};
let requests = 0;
const decoder = new StringDecoder('utf8'); let pending = '';
outer: for await (const chunk of process.stdin) {
  pending += decoder.write(chunk);
  if (Buffer.byteLength(pending) > 240 * 1024) { process.exitCode = 1; break; }
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
  if (++requests > 128) break outer;
  let request;
  try { request = JSON.parse(line); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
  if (request.id === undefined) continue;
  let response;
  try {
    if (request.method === 'initialize') response = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'matrix_bot', version: '1.0.0' } };
    else if (request.method === 'ping') response = {};
    else if (request.method === 'tools/list') response = await send('list', {});
    else if (request.method === 'tools/call' && request.params?.name === 'call') response = await send('call', { tool: request.params.arguments });
    else throw new Error('Unsupported method');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: response }) + '\n');
  } catch (error) {
    console.error('[bot-task-mcp] Request unavailable:', error instanceof Error ? error.name : 'UnknownError');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Task action unavailable' } }) + '\n');
  }
}

}
