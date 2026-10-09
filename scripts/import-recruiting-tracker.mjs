#!/usr/bin/env node
// Explicit one-time migration of stored recruiting data. Never calls the Gmail integration.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const host = process.argv[2];
if (!host || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(host)) throw Error('Pass a configured SSH host alias');
const origin = new URL(process.env.PLATFORM_API_URL ?? 'https://api.matrix-os.com');
if (origin.protocol !== 'https:' || !process.env.ATS_ADMIN_SECRET || !process.env.ATS_MIGRATION_ACTOR_ID) throw Error('Set ATS_ADMIN_SECRET and ATS_MIGRATION_ACTOR_ID');
const remote = String.raw`
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const config = Object.fromEntries(readFileSync('/opt/matrix/env/host.env','utf8').split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1).replace(/^['"]|['"]$/g,'')];}));
const query = async (table, extra={}) => {
  const response=await fetch('http://127.0.0.1:4000/api/bridge/query',{method:'POST',headers:{authorization:'Bearer '+config.MATRIX_AUTH_TOKEN,'x-platform-user-id':config.MATRIX_CLERK_USER_ID,'content-type':'application/json'},body:JSON.stringify({app:'recruiting-tracker',action:'find',table,limit:1000,...extra}),signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw Error('Stored tracker read failed');
  const result=await response.json(); return result.rows ?? result.data ?? result;
};
const rows = async table => {const all=[];for(let offset=0;offset<10000;offset+=1000){const batch=await query(table,{offset});if(!Array.isArray(batch))throw Error('Unexpected stored data response');all.push(...batch);if(batch.length<1000)return all;}throw Error('Export exceeds row cap');};
const candidates=await rows('candidates'), comments=await rows('comments'), inbox=await rows('inbox_items'), files=await rows('files');
const stage={New:'applied',Screening:'screening',Contacted:'intro_call',Interview:'technical_interview',Assessment:'technical_interview',Offer:'offer',Hired:'hired',Archived:'applied',Rejected:'applied'};
const role={ 'Founding Software Engineer':'founding-engineer', 'Founding Engineer':'founding-engineer', 'Founder Associate':'associate', "Founder's Associate":'associate', 'Founder’s Associate':'associate' };
const date=(v)=> Number.isNaN(Date.parse(v)) ? new Date().toISOString() : new Date(v).toISOString();
for(const candidate of candidates){
  const attachments=[];
  for(const file of files.filter(file=>file.candidate_id===candidate.id)){
    if(!['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.mime_type))continue;
    const chunks=await query('file_chunks',{filter:{file_id:file.id}});
    if(chunks.length!==file.chunk_count)throw Error('Incomplete stored CV');
    attachments.push({filename:file.name,contentType:file.mime_type,base64:chunks.sort((a,b)=>a.idx-b.idx).map(chunk=>chunk.data).join('')});
  }
  const linked=inbox.filter(mail=>mail.candidate_id===candidate.id);
  const payload={legacyKey:config.MATRIX_CLERK_USER_ID+':'+candidate.id,name:candidate.full_name,email:candidate.email,roleSlug:role[candidate.role]??'legacy-unassigned',stage:stage[candidate.status]??'applied',disposition:candidate.status==='Archived'?'archived':candidate.status==='Rejected'?'rejected':'active',summary:candidate.summary??'',createdAt:date(candidate.created_at),notes:comments.filter(note=>note.candidate_id===candidate.id).map(note=>({body:note.body,createdAt:date(note.created_at)})),emails:linked.map(mail=>({messageId:mail.message_id,threadId:mail.thread_id??'',senderName:mail.sender_name??'',senderEmail:mail.sender_email,subject:mail.subject??'',body:mail.snippet??'',receivedAt:date(mail.received_at),sourceUrl:mail.source_url,category:'candidate'})),attachments};
  const line=JSON.stringify({type:'candidate',payload})+'\n';if(Buffer.byteLength(line)>8*1024*1024)throw Error('Candidate exceeds migration size limit');
  if(!process.stdout.write(line))await new Promise(resolve=>process.stdout.once('drain',resolve));
}
for(const mail of inbox.filter(mail=>!mail.candidate_id)){
 const category={'Vendor':'vendor','Moderation':'moderation','Groups pending':'moderation'}[mail.category]??'needs_review';
 const payload={messageId:'legacy-'+createHash('sha256').update(mail.message_id??mail.id).digest('hex'),threadId:mail.thread_id??'',senderName:mail.sender_name??'',senderEmail:mail.sender_email,subject:mail.subject??'',body:mail.snippet??'',receivedAt:date(mail.received_at),sourceUrl:mail.source_url,category,attachments:[]};
 if(!process.stdout.write(JSON.stringify({type:'mail',payload})+'\n'))await new Promise(resolve=>process.stdout.once('drain',resolve));
}
`;
const child = spawn('ssh', [host, '/opt/matrix/runtime/node/bin/node', '--input-type=module'], { stdio: ['pipe', 'pipe', 'inherit'] });
const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(Error('Stored tracker export failed'))); });
// Install a rejection handler immediately; failures are rethrown after the stream drains.
done.catch((error) => {
  console.error('Stored tracker export failed:', error instanceof Error ? error.name : typeof error);
});
child.stdin.end(remote);
let count = 0;
let mailCount = 0;
try {
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw Error('Candidate exceeds migration size limit');
    const record = JSON.parse(line);
    if (!["candidate", "mail"].includes(record.type)) throw Error("Unexpected migration record");
    const endpoint = record.type === "candidate" ? "legacy-import" : "legacy-inbox";
    const response = await fetch(new URL(`/api/ats/admin/${endpoint}`, origin.origin), {
      method: 'POST', headers: { authorization: `Bearer ${process.env.ATS_ADMIN_SECRET}`, 'x-ats-actor-id': process.env.ATS_MIGRATION_ACTOR_ID, 'content-type': 'application/json' },
      body: JSON.stringify(record.payload), signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    if (!response.ok) throw Error('Candidate migration failed; reruns safely resume accepted records');
    if (record.type === "candidate") count++; else mailCount++;
  }
  await done;
  console.log(`Imported ${count} candidates and ${mailCount} unlinked inbox items from stored recruiting data.`);
} finally { child.kill(); }
