// Offline Linux filesystem fixture; bundle this entry for Node and run in a
// network-disabled disposable test container. It makes no provider/API calls.
import assert from 'node:assert/strict';
import { relative } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink, chown, link } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { readManagedPiValidationLimits } from '../../../packages/gateway/src/chat/managed-pi-validation-limits.ts';
const now = Date.parse('2026-10-09T12:00:00.000Z');
const profile = { version: 1, maxOutputTokens: 256, maxInferenceRequests: 1, maxRequestBytes: 131072, validThrough: '2026-10-09T12:30:00.000Z' };
let passed = 0;
async function test(name, fn) { const home = await mkdtemp('/tmp/managed-pi-fixture-'); await mkdir(home+'/system'); try { await fn(home, home+'/system/managed-pi-validation.json'); passed++; console.log('PASS '+name); } finally { await rm(home,{force:true,recursive:true}); } }
await test('absent profile', async h => assert.equal(await readManagedPiValidationLimits(h,now), undefined));
for (const mode of [0o600]) await test('valid profile mode '+mode.toString(8), async (h,p) => {await writeFile(p,JSON.stringify(profile),{mode}); assert.deepEqual(await readManagedPiValidationLimits(h,now), profile);});
await test('relative home anchored profile', async (h,p) => {await writeFile(p,JSON.stringify(profile),{mode:0o600});assert.deepEqual(await readManagedPiValidationLimits(relative(process.cwd(),h),now),profile);});
await test('0644 refuses', async (h,p) => {await writeFile(p,JSON.stringify(profile),{mode:0o644});await assert.rejects(readManagedPiValidationLimits(h,now));});
await test('writable home refuses', async (h,p) => {await writeFile(p,JSON.stringify(profile),{mode:0o600});await chmod(h,0o777);await assert.rejects(readManagedPiValidationLimits(h,now));});
await test('expired profile', async (h,p) => {await writeFile(p,JSON.stringify({...profile,validThrough:new Date(now).toISOString()}),{mode:0o600});await assert.rejects(readManagedPiValidationLimits(h,now));});
await test('oversized profile', async (h,p) => {await writeFile(p,'x'.repeat(4097),{mode:0o600});await assert.rejects(readManagedPiValidationLimits(h,now));});
await test('malformed profile', async (h,p) => {await writeFile(p,'{',{mode:0o600});await assert.rejects(readManagedPiValidationLimits(h,now));});
await test('writable profile', async (h,p) => {await writeFile(p,JSON.stringify(profile));await chmod(p,0o666);await assert.rejects(readManagedPiValidationLimits(h,now));});
await test('wrong owner', async (h,p) => {await writeFile(p,JSON.stringify(profile),{mode:0o600});await chown(p,1234,1234);await assert.rejects(readManagedPiValidationLimits(h,now));});
await test('symlink profile', async (h,p) => {await writeFile(h+'/other',JSON.stringify(profile));await symlink(h+'/other',p);await assert.rejects(readManagedPiValidationLimits(h,now));});
await test('dangling profile', async (h,p) => {await symlink(h+'/missing',p);await assert.rejects(readManagedPiValidationLimits(h,now));});
await test('symlink ancestor', async h => {await rm(h+'/system',{recursive:true});await mkdir(h+'/other');await symlink(h+'/other',h+'/system');await writeFile(h+'/other/managed-pi-validation.json',JSON.stringify(profile));await assert.rejects(readManagedPiValidationLimits(h,now));});
await test('writable ancestor', async (h,p) => {await writeFile(p,JSON.stringify(profile));await chmod(h+'/system',0o777);await assert.rejects(readManagedPiValidationLimits(h,now));});
await test('hard link', async (h,p) => {await writeFile(p,JSON.stringify(profile),{mode:0o600});await link(p,h+'/other');await assert.rejects(readManagedPiValidationLimits(h,now));});
await test('FIFO refuses without blocking', async (h,p) => {assert.equal(spawnSync('mkfifo',[p]).status,0);await assert.rejects(readManagedPiValidationLimits(h,now));});
console.log(JSON.stringify({platform:process.platform,node:process.version,passed,liveCalls:0}));
