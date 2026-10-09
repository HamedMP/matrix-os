#!/usr/bin/env node
// Reads only the explicitly captured Google Group archive, never a Gmail mailbox.
// Run with Node 24 --import tsx. Delete the private source folder after verified import.
import {readFile,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {z} from 'zod/v4';
import {normalizeGroupMail,MAX_RAW_MAIL_BYTES} from '../packages/platform/src/ats-group-mail.ts';
const folder=resolve(process.argv[2]??'');
if(!process.argv[2])throw Error('Pass the private archive folder');
const manifest=z.array(z.object({filename:z.string().regex(/^[A-Za-z0-9_-]+-\d+\.eml$/),sourceUrl:z.string().regex(/^https:\/\/groups\.google\.com\/a\/finna\.ai\/g\/careers\/c\/[A-Za-z0-9_-]+$/),bytes:z.number().int().positive().max(MAX_RAW_MAIL_BYTES)})).max(1000).parse(JSON.parse(await readFile(join(folder,'manifest.json'),'utf8')));
const readOriginal=async entry=>{
 const path=join(folder,entry.filename);const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_RAW_MAIL_BYTES||stat.size!==entry.bytes)throw Error('Invalid original email file');
 return normalizeGroupMail(await readFile(path),new Date().toISOString(),entry.sourceUrl);
};
const unique=new Map();let attachments=0;
for(const entry of manifest){const mail=await readOriginal(entry);if(!unique.has(mail.messageId)){unique.set(mail.messageId,{entry,date:mail.receivedAt});attachments+=mail.attachments.length;}}
console.log(`Validated ${unique.size} unique original emails with ${attachments} attachments.`);
if(!process.argv.includes('--apply'))process.exit(0);
if(!process.env.ATS_ADMIN_SECRET)throw Error('ATS_ADMIN_SECRET is required');
const origin=new URL(process.env.PLATFORM_API_URL??'https://api.matrix-os.com');if(origin.protocol!=='https:')throw Error('HTTPS platform origin is required');
let imported=0;
for(const {entry} of [...unique.values()].sort((a,b)=>a.date.localeCompare(b.date))){
 const mail=await readOriginal(entry);
 const response=await fetch(new URL('/api/ats/admin/legacy-inbox',origin.origin),{method:'POST',headers:{authorization:`Bearer ${process.env.ATS_ADMIN_SECRET}`,'content-type':'application/json'},body:JSON.stringify(mail),signal:AbortSignal.timeout(30000),redirect:'error'});
 if(!response.ok)throw Error('Archive import failed; rerun safely resumes accepted originals');imported++;
}
console.log(`Imported ${imported} original emails. Slack backfill remains an explicit separate step.`);
