import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {parse} from 'yaml';
import {authenticatedRequestingRun} from '../../scripts/ci/dedicated-refresh.mjs';
const ci=parse(readFileSync('.github/workflows/ci.yml','utf8'));
const format=(text:string,...values:unknown[])=>text.replace(/\{(\d+)\}/g,(_,i)=>String(values[Number(i)]));
function expression(text:string,github:any,inputs={}){if(!text.startsWith('${{')&&!text.includes('always('))return text;return Function('github','inputs','format','always',`return (${text.replace(/^\$\{\{\s*|\s*\}\}$/g,'')});`)(github,inputs,format,()=>true);}
const sha='a'.repeat(40),head='b'.repeat(40),base='c'.repeat(40),repo={owner:'HamedMP',repo:'matrix-os'};
describe('metadata-only PR events cannot replace required coverage',()=>{
 it.each(['title','body'])('isolates ready %s edits from CI Results and requesting provenance',field=>{
  const github={event_name:'pull_request',sha,event:{action:'edited',changes:{[field]:{from:'before'}},pull_request:{number:2454,labels:[{name:'ready-for-ci'},{name:'ci-linux'}]}}};
  const title=expression(ci['run-name'],github);expect(title).toContain('CI metadata-v1');
  expect(expression(ci.jobs['ci-results'].name,github)).not.toBe('CI Results');
  expect(expression(ci.jobs['ci-results'].if,github)).toBe(false);
  const run={id:123,workflow_id:98,path:'.github/workflows/ci.yml',event:'pull_request',head_sha:head,repository:{full_name:'HamedMP/matrix-os'},head_repository:{full_name:'HamedMP/matrix-os'},display_title:title,pull_requests:[{number:2454,head:{sha:head},base:{sha:base,ref:'stack/parent'}}]};
  expect(authenticatedRequestingRun(run,repo,{prNumber:2454,headSha:head,baseSha:base,sourceSha:sha,baseRef:'stack/parent'},{id:98})).toBe(false);
 });
 it.each(['edited','synchronize','labeled'])('keeps source %s events on the genuine aggregate',action=>{
  const github={event_name:'pull_request',sha,event:{action,changes:{base:{ref:{from:'old'}}},pull_request:{number:2454}}};
  expect(expression(ci['run-name'],github)).toBe(`CI coverage-v1 · ${sha}`);
  expect(expression(ci.jobs['ci-results'].name,github)).toBe('CI Results');expect(expression(ci.jobs['ci-results'].if,github)).toBe(true);
 });
});
