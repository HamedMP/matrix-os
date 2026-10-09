import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
it('teaches app builders the distinct public data/form bridge and reviewed deployment flow',()=>{
 for(const path of ['skills/matrix/app-builder/SKILL.md','home/agents/knowledge/app-generation.md']) {
  const content=readFileSync(path,'utf8');
  for(const term of ['MatrixOS.site.data','MatrixOS.site.submit','reviewedConfig','matrix.page','/api/apps/:slug/site']) expect(content).toContain(term);
  expect(content).toContain('Private Matrix bridges');
  expect(content).toContain('Scoped Chat runs cannot publish');
  expect(content).not.toContain('Use the existing authenticated owner transport');
 }
});
