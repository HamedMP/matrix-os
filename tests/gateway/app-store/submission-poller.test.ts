import {describe,it,expect} from 'vitest';
import {submissionTransitions} from '../../../packages/gateway/src/app-store/submission-poller.js';
describe('submission changes',()=>{
 it('stays quiet for initial and unchanged status, emits only meaningful transitions',()=>{
  expect(submissionTransitions({},[{versionId:'one',status:'in_review'}])).toEqual([]);
  expect(submissionTransitions({one:'in_review'},[{versionId:'one',status:'in_review'}])).toEqual([]);
  expect(submissionTransitions({one:'in_review'},[{versionId:'one',status:'published'}])).toEqual([{versionId:'one',status:'published'}]);
 });
});
