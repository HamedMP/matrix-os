import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Starter trial deployment configuration', () => {
  it.each(['platform-cloud-run.yml', 'preview-platform.yml'])('deploys independent plan durations in %s', (name) => {
    const workflow = readFileSync(`.github/workflows/${name}`, 'utf8');
    expect(workflow).toContain("MATRIX_CARD_TRIAL_DAYS: ${{ vars.MATRIX_CARD_TRIAL_DAYS || '3' }}");
    expect(workflow).toContain("MATRIX_STARTER_TRIAL_DAYS: ${{ vars.MATRIX_STARTER_TRIAL_DAYS || '14' }}");
    expect(workflow).toContain('MATRIX_STARTER_TRIAL_DAYS must be an integer from 1 to 30.');
    // Each deployed process receiving the legacy duration must receive Starter's
    // duration too, including the background worker configuration.
    const bindings = workflow.split('\n').filter((line) => line.includes('MATRIX_CARD_TRIAL_DAYS=${MATRIX_CARD_TRIAL_DAYS}'));
    expect(bindings.length).toBeGreaterThan(0);
    for (let index = 0; index < bindings.length; index++) {
      const line = bindings[index]!;
      if (line.trim() === '"MATRIX_CARD_TRIAL_DAYS=${MATRIX_CARD_TRIAL_DAYS}"') {
        expect(workflow).toContain('"MATRIX_STARTER_TRIAL_DAYS=${MATRIX_STARTER_TRIAL_DAYS}"');
      } else {
        expect(line).toContain('MATRIX_STARTER_TRIAL_DAYS=${MATRIX_STARTER_TRIAL_DAYS}');
      }
    }
  });
});
