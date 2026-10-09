import { expect, it } from 'vitest';
import { agentRecipePatch } from '../../../packages/ui/src/chat-agents/recipe-edit.js';
import { saved } from '../../desktop/chat-agents-fixture.js';

it('persists custom coordinator recipe edits while preserving fixed server recipe definitions', () => {
 const original={skills:[],integrations:[],output:'A short answer'};
 const recipe={...original,output:'A revised answer'};
 const managed={...saved,recipeRef:{recipeId:'custom-coordinator',version:'1'},recipe:original};
 expect(agentRecipePatch(managed,recipe)).toEqual({recipe});
 expect(agentRecipePatch({...managed,recipeRef:{recipeId:'writing-bot',version:'1'}},recipe)).toEqual({});
 expect(agentRecipePatch(managed,null)).toEqual({recipe:null});
});
