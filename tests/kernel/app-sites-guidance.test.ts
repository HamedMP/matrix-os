import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SitePublishingSchema, validateSiteForm } from '../../packages/contracts/src/sites.js';
it('teaches app builders the distinct public data/form bridge and reviewed deployment flow',()=>{
 for(const path of ['skills/matrix/app-builder/SKILL.md','home/agents/knowledge/app-generation.md']) {
  const content=readFileSync(path,'utf8');
  for(const term of ['MatrixOS.site.data','MatrixOS.site.submit','reviewedConfig','matrix.page','/api/apps/:slug/site']) expect(content).toContain(term);
  expect(content).toContain('Private Matrix bridges');
  expect(content).toContain('Scoped Chat runs cannot publish');
  expect(content).not.toContain('Use the existing authenticated owner transport');
 }
});
it('provides a complete valid optional form declaration that builders can reuse', () => {
 for (const path of ['skills/matrix/app-builder/SKILL.md', 'home/agents/knowledge/app-generation.md']) {
  const content = readFileSync(path, 'utf8').split('Optional visitor form example')[1];
  expect(content).toBeDefined();
  const example = content?.match(/```json\n([\s\S]*?)\n```/)?.[1];
  expect(example).toBeDefined();
  const config = SitePublishingSchema.parse(JSON.parse(example!).publishing);
  const form = config.forms[0]!;
  expect(validateSiteForm(form, { name: 'Ada', email: 'ada@example.com', guests: 2, updates: true }).success).toBe(true);
  expect(validateSiteForm(form, { name: '', email: 'ada@example.com', guests: 2 }).success).toBe(false);
  expect(validateSiteForm(form, { name: 'Ada', email: 'ada@example.com', guests: 21 }).success).toBe(false);
  expect(validateSiteForm(form, { name: 'Ada', email: 'ada@example.com', guests: 2, private_token: 'secret' }).success).toBe(false);
 }
});
