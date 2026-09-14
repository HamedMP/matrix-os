import { mergeNativeSpeechDraft } from '../lib/speech/draft';

it('inserts a transcript once into the recording-owned draft revision', () => {
  const first = mergeNativeSpeechDraft({ current: 'typed', currentGeneration: 4, recordingGeneration: 4, transcript: 'dictated' });
  expect(first).toEqual({ ok: true, value: 'typed dictated', generation: 5 });
  expect(mergeNativeSpeechDraft({ current: first.value, currentGeneration: first.generation, recordingGeneration: 4, transcript: 'dictated' }))
    .toEqual({ ok: false, reason: 'stale', value: 'typed dictated', generation: 5 });
});

it('appends after ordinary typed edits but fences an explicit clear or reset', () => {
  expect(mergeNativeSpeechDraft({ current: 'typed while waiting', currentGeneration: 2, recordingGeneration: 2, transcript: 'dictated' }))
    .toEqual({ ok: true, value: 'typed while waiting dictated', generation: 3 });
  expect(mergeNativeSpeechDraft({ current: '', currentGeneration: 3, recordingGeneration: 2, transcript: 'stale speech' }))
    .toEqual({ ok: false, reason: 'stale', value: '', generation: 3 });
});

it('leaves the draft unchanged when the combined canonical message would be too large', () => {
  const current = 'a'.repeat(31_999);
  expect(mergeNativeSpeechDraft({ current, currentGeneration: 7, recordingGeneration: 7, transcript: 'more' }))
    .toEqual({ ok: false, reason: 'too_large', value: current, generation: 7 });
});
