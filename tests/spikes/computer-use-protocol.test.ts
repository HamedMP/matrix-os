import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { createQualificationMcpServer, createQualificationStdioTransport, stopOnTransportLoss } from "../../scripts/spikes/computer-use/mcp.mjs";
import { createQualificationSession } from "../../scripts/spikes/computer-use/session.mjs";

// Synthetic PNG bytes only. This protects MCP content typing, not screen/model acceptance.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=";
it("delivers image content through the real MCP client/server boundary rather than JSON text", async () => {
  const session = { execute: async () => ({ observationId: "obs", width: 1, height: 1, data: png, leaseEpoch: 1, geometryRevision: 1 }) };
  const server = createQualificationMcpServer(session);
  const client = new Client({ name: "computer-protocol-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const result = await client.callTool({ name: "computer_qualification", arguments: { input: { action: "observe" } } });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ observationId: "obs", width: 1, height: 1, leaseEpoch: 1, geometryRevision: 1 }) },
      { type: "image", mimeType: "image/png", data: png },
    ]);
  } finally { await client.close(); await server.close(); }
});

it('refuses invalid pixels and model-selected display without returning bytes',async()=>{
  let called=0;
  const server=createQualificationMcpServer({execute:async()=>{called++;return {data:png,width:1600,height:1600};}});
  const client=new Client({name:'computer-negative-test',version:'1'}); const[a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b),client.connect(a)]);
  try {
    const bad=await client.callTool({name:'computer_qualification',arguments:{input:{action:'observe'}}});
    expect(bad.isError).toBe(true); expect(JSON.stringify(bad)).not.toContain(png);
    const endpoint=await client.callTool({name:'computer_qualification',arguments:{input:{action:'observe',display:':0'}}});
    expect(endpoint.isError).toBe(true); expect(called).toBe(1);
  } finally {await client.close();await server.close();}
});

it.each([
  ['header-only',Buffer.from(png,'base64').subarray(0,33).toString('base64')],
  ['invalid chunk checksum','iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTioAAAAASUVORK5CYII='],
])('refuses malformed PNG %s even when its reported geometry matches the header',async(_,data)=>{
  const server=createQualificationMcpServer({execute:async()=>({data,width:1,height:1})});
  const client=new Client({name:'computer-truncated-test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b),client.connect(a)]);
  try {
    const result=await client.callTool({name:'computer_qualification',arguments:{input:{action:'observe'}}});
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{type:'text',text:'qualification_unavailable'}]);
  } finally {await client.close();await server.close();}
});

it.each(['input_error','oversized_input'])('revokes held input immediately on MCP transport %s while operator presence is fresh',async(fault)=>{
  const calls:string[][]=[];let pressed!:()=>void;const didPress=new Promise<void>(r=>pressed=r);
  const session=createQualificationSession({platform:'linux',grant:{ownerId:'owner',chatId:'chat',runId:'run',targetId:'pv-123-1234abcd',display:':7',modelRoute:'vision',syntheticOnly:true,expiresAt:Date.now()+60000},backend:{
    capture:async()=>({width:1,height:1,data:png}),geometry:async()=>({width:1,height:1}),command:async(args:string[],signal:AbortSignal)=>{
      calls.push(args);if(args[0]==='keydown'){pressed();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}
    },
  }});
  const input=new PassThrough(),output=new PassThrough();const server=createQualificationMcpServer(session);
  let finished!:()=>void;const shutdownDone=new Promise<void>(r=>finished=r);
  const shutdown=async()=>{await session.stop();await server.close();finished();};
  const transport=stopOnTransportLoss(new StdioServerTransport(input,output,{maxBufferSize:32}),shutdown,(error:unknown)=>{throw error;});
  await server.connect(transport);
  try {
    const frame=await session.execute({action:'observe'});
    if(!('observationId' in frame))throw new Error('observation required');
    const pending=session.execute({action:'key',keys:['CTRL'],actionId:'transport1',observationId:frame.observationId,leaseEpoch:frame.leaseEpoch,geometryRevision:frame.geometryRevision}).catch((error:Error)=>error.message);
    await didPress;session.presence();
    if(fault==='input_error')input.emit('error',new Error('synthetic_transport_failure'));
    else input.write(Buffer.alloc(33));
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([shutdownDone,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('transport shutdown missing')),1000);})]);}
    finally {clearTimeout(deadline);}
    expect(await pending).toBe('cancelled');
    expect(calls).toEqual([['keydown','CTRL'],['keyup','CTRL']]);
    expect(()=>session.presence()).toThrow('qualification_unavailable');
  } finally {await session.stop();await server.close();input.destroy();output.destroy();}
});

it('closes and signals stop before stdout backpressure can accumulate unbounded replies',async()=>{
  const input=new PassThrough(),output=new PassThrough({highWaterMark:1});let stopped=0;
  const transport=stopOnTransportLoss(createQualificationStdioTransport(input,output,128),async()=>{stopped++;},(error:unknown)=>{throw error;});
  await transport.start();
  const message={jsonrpc:'2.0' as const,method:'synthetic',params:{text:'x'.repeat(30)}};
  const pending=transport.send(message);
  try {
    expect(output.writableLength).toBeGreaterThan(0);
    const overflow=transport.send(message).catch((error:Error)=>error.message);
    expect(output.writableLength).toBeLessThanOrEqual(128);
    expect(await overflow).toBe('transport_output_limit');
    expect(stopped).toBe(1);
    await expect(transport.send(message)).rejects.toThrow('transport_unavailable');
  } finally {output.resume();await pending;await transport.close();input.destroy();output.destroy();}
});

it('publishes the real per-action input contract during MCP tool discovery',async()=>{
 const server=createQualificationMcpServer({execute:async()=>{throw Error('disabled');}});
 const client=new Client({name:'computer-discovery-test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();
 await Promise.all([server.connect(b),client.connect(a)]);
 try{const listed=await client.listTools();const schema=listed.tools[0].inputSchema;expect(schema.type).toBe('object');expect(schema.properties).toHaveProperty('input');expect(schema.required).toEqual(['input']);expect(JSON.stringify(schema)).toContain('observationId');expect(JSON.stringify(schema)).toContain('geometryRevision');}
 finally{await client.close();await server.close();}
});
