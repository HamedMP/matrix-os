import { mergeNativeSpeechDraft } from '../lib/speech/draft';

it('inserts a transcript once into the recording-owned draft revision', () => {
  const first = mergeNativeSpeechDraft({ current: 'typed', currentRevision: 4, recordingRevision: 4, transcript: 'dictated' });
  expect(first).toEqual({ ok: true, value: 'typed dictated', revision: 5 });
  expect(mergeNativeSpeechDraft({ current: first.value, currentRevision: first.revision, recordingRevision: 4, transcript: 'dictated' }))
    .toEqual({ ok: false, reason: 'stale', value: 'typed dictated', revision: 5 });
});

it('preserves typed edits and explicit clears made while transcription is pending', () => {
  expect(mergeNativeSpeechDraft({ current: 'typed later', currentRevision: 2, recordingRevision: 1, transcript: 'stale speech' }))
    .toEqual({ ok: false, reason: 'stale', value: 'typed later', revision: 2 });
  expect(mergeNativeSpeechDraft({ current: '', currentRevision: 3, recordingRevision: 2, transcript: 'stale speech' }))
    .toEqual({ ok: false, reason: 'stale', value: '', revision: 3 });
});

it('leaves the draft unchanged when the combined canonical message would be too large', () => {
  const current = 'a'.repeat(31_999);
  expect(mergeNativeSpeechDraft({ current, currentRevision: 7, recordingRevision: 7, transcript: 'more' }))
    .toEqual({ ok: false, reason: 'too_large', value: current, revision: 7 });
});
