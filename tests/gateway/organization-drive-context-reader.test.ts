import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readVerifiedDriveText } from "../../packages/gateway/src/organization-drive/context-reader.js";
const bytes=(text: string)=>new TextEncoder().encode(text);
const sha=(data: Uint8Array)=>createHash("sha256").update(data).digest("hex");
const stream=(data: Uint8Array)=>new ReadableStream<Uint8Array>({start(c){c.enqueue(data);c.close();}});
describe("organization drive read-only text context", () => {
 it.each(["web", "node"])("verifies %s bytes and returns only bounded text with truncation", async kind => {
  const data=bytes("Drive reference. ".repeat(4000));
  const result=await readVerifiedDriveText({body:kind==="web"?stream(data):Readable.from([data]),size:data.byteLength,sha256:sha(data),signal:AbortSignal.timeout(1000)});
  expect(result.truncated).toBe(true); expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(32768);
  expect(result.text.startsWith("Drive reference.")).toBe(true);
 });
 it("does not return any text when size/hash verification fails", async () => {
  const data=bytes("private shared text");
  await expect(readVerifiedDriveText({body:stream(data),size:data.byteLength,sha256:"0".repeat(64),signal:AbortSignal.timeout(1000)})).rejects.toMatchObject({code:"checksum"});
  await expect(readVerifiedDriveText({body:stream(data),size:data.byteLength-1,sha256:sha(data),signal:AbortSignal.timeout(1000)})).rejects.toMatchObject({code:"checksum"});
 });
 it("rejects binary and invalid UTF-8 even when their hashes match", async () => {
  for (const data of [new Uint8Array([65,0,66]),new Uint8Array([255,254,65])]) {
   await expect(readVerifiedDriveText({body:stream(data),size:data.byteLength,sha256:sha(data),signal:AbortSignal.timeout(1000)})).rejects.toMatchObject({code:"unsupported"});
  }
 });
 it("aborts a stalled body instead of keeping the request alive", async () => {
  let cancelled=false;const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});const controller=new AbortController();
  const pending=readVerifiedDriveText({body,size:1,sha256:"0".repeat(64),signal:controller.signal});controller.abort();
  await expect(pending).rejects.toBeTruthy();expect(cancelled).toBe(true);
 });
 it("does not wait for an unresponsive stream cleanup after rejecting oversized content", async () => {
  const data=new Uint8Array([0]);const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(data);},cancel(){return new Promise<void>(()=>undefined);}});
  const pending=readVerifiedDriveText({body,size:0,sha256:sha(data),signal:AbortSignal.timeout(10_000)});
  const outcome=await Promise.race([pending.then(()=>"resolved",()=>"rejected"),new Promise(resolve=>setTimeout(()=>resolve("stalled"),100))]);
  expect(outcome).toBe("rejected");
 });
 it("does not split a multibyte character at the preview boundary", async () => {
  const data=bytes("a".repeat(32767)+"🌳"+"z");const result=await readVerifiedDriveText({body:stream(data),size:data.byteLength,sha256:sha(data),signal:AbortSignal.timeout(1000)});
  expect(result.text).not.toContain("�");expect(result.truncated).toBe(true);
 });
 it("verifies a 4 MiB file fragmented into 8192 small chunks", async () => {
  const data=bytes("a".repeat(4*1024*1024));let offset=0;
  const body=new ReadableStream<Uint8Array>({pull(c){if(offset===data.length){c.close();return;}c.enqueue(data.subarray(offset,offset+512));offset+=512;}});
  expect(await readVerifiedDriveText({body,size:data.length,sha256:sha(data),signal:AbortSignal.timeout(5000)})).toMatchObject({truncated:true});
 });
 it("reports integrity failure before classifying corrupted binary content", async () => {
  const data=bytes("bad\0");await expect(readVerifiedDriveText({body:stream(data),size:data.length,sha256:sha(bytes("good")),signal:AbortSignal.timeout(1000)})).rejects.toMatchObject({code:"checksum"});
 });

});
