import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {parse} from 'yaml';

const raw=readFileSync('.github/workflows/codeql.yml','utf8');
const workflow=parse(raw) as {on:Record<string,unknown>,permissions:Record<string,string>,jobs:Record<string,{strategy:{matrix:{language:string[]}},steps:{uses?:string}[]}>};

it('scans weekly or on demand only, so pushes and PRs keep their runners',()=>{
 expect(Object.keys(workflow.on).sort()).toEqual(['schedule','workflow_dispatch']);
 expect(workflow.on.schedule).toEqual([{cron:expect.stringMatching(/^\d+ \d+ \* \* 0$/)}]);
});

it('grants only what code scanning uploads need',()=>{
 expect(workflow.permissions).toEqual({actions:'read',contents:'read','security-events':'write'});
});

it('covers TypeScript and workflow definitions with pinned actions',()=>{
 expect(workflow.jobs.analyze.strategy.matrix.language).toEqual(['javascript-typescript','actions']);
 for(const step of workflow.jobs.analyze.steps.filter(step=>step.uses))expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
 expect(workflow.jobs.analyze.steps.filter(step=>step.uses?.startsWith('github/codeql-action/init@'))).toEqual([expect.objectContaining({uses:expect.stringMatching(/^github\/codeql-action\/init@[a-f0-9]{40}$/)})]);
});
